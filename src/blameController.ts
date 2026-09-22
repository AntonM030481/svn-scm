import {
  commands,
  Disposable,
  Range,
  TextDocumentChangeEvent,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  Uri,
  window,
  workspace
} from "vscode";
import { SourceControlManager } from "./source_control_manager";
import { SvnBlameLine } from "./parser/blameParser";
import { shiftBlameLines } from "./blameModel";
import { Repository } from "./repository";
import { SvnCancellationError } from "./svnProcess";

interface BlameRecord {
  repository: Repository;
  lines: SvnBlameLine[];
  logs: Map<string, string>;
  decorations: TextEditorDecorationType[];
  activeDecoration?: TextEditorDecorationType;
}

interface PendingBlame {
  repository: Repository;
  controller: AbortController;
  generation: number;
}

const VIEWPORT_BUFFER = 200;

function iconForRevision(revision: string): Uri {
  let hash = 0;
  for (const char of revision) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="hsl(${hue} 60% 55%)"/></svg>`;
  return Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function hoverText(line: SvnBlameLine, log?: string): string {
  const parts = [`r${line.revision}`];
  if (line.author) parts.push(line.author);
  if (line.date) parts.push(formatDate(line.date));
  let text = parts.join(" · ");
  if (log) text += `\n\n${log}`;
  return text;
}

export class BlameController implements Disposable {
  private readonly records = new Map<string, BlameRecord>();
  private readonly disposables: Disposable[] = [];
  private readonly requestGenerations = new Map<string, number>();
  private readonly pendingBlame = new Map<string, PendingBlame>();
  private readonly selectionGenerations = new Map<string, number>();
  private readonly pendingLog = new Map<string, AbortController>();
  private disposed = false;

  constructor(private readonly sourceControlManager: SourceControlManager) {
    this.disposables.push(
      commands.registerCommand("svn.blame.show", () => this.showActive()),
      commands.registerCommand("svn.blame.hide", () => this.hideActive()),
      commands.registerCommand("svn.blame.toggle", () => this.toggleActive()),
      window.onDidChangeActiveTextEditor(
        editor => void this.onActiveEditor(editor)
      ),
      window.onDidChangeTextEditorSelection(
        event => void this.onSelection(event.textEditor)
      ),
      window.onDidChangeTextEditorVisibleRanges(event =>
        this.render(event.textEditor)
      ),
      workspace.onDidChangeTextDocument(event => this.onDocumentChange(event)),
      workspace.onDidCloseTextDocument(document =>
        this.clear(document.uri.fsPath)
      ),
      sourceControlManager.onDidCloseRepository(repository =>
        this.clearRepository(repository)
      )
    );

    void this.onActiveEditor(window.activeTextEditor);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();

    const files = new Set([
      ...this.records.keys(),
      ...this.pendingBlame.keys(),
      ...this.pendingLog.keys()
    ]);
    for (const file of files) this.clear(file);
  }

  private nextRequestGeneration(file: string): number {
    const generation = (this.requestGenerations.get(file) ?? 0) + 1;
    this.requestGenerations.set(file, generation);
    return generation;
  }

  private cancelSelection(file: string): void {
    this.selectionGenerations.set(
      file,
      (this.selectionGenerations.get(file) ?? 0) + 1
    );
    this.pendingLog.get(file)?.abort();
    this.pendingLog.delete(file);
  }

  private async onActiveEditor(editor?: TextEditor): Promise<void> {
    if (!editor || editor.document.uri.scheme !== "file") return;
    if (
      workspace
        .getConfiguration("svn", editor.document.uri)
        .get<boolean>("blame.auto")
    ) {
      await this.show(editor, false);
    }
  }

  private async showActive(): Promise<void> {
    const editor = window.activeTextEditor;
    if (editor) await this.show(editor, true);
  }

  private hideActive(): void {
    const editor = window.activeTextEditor;
    if (editor) this.clear(editor.document.uri.fsPath);
  }

  private async toggleActive(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return;
    const file = editor.document.uri.fsPath;

    if (this.records.has(file) || this.pendingBlame.has(file)) {
      this.clear(file);
    } else {
      await this.show(editor, true);
    }
  }

  private async show(editor: TextEditor, interactive: boolean): Promise<void> {
    const document = editor.document;
    const file = document.uri.fsPath;

    if (document.uri.scheme !== "file") return;
    if (document.isDirty) {
      if (interactive) {
        window.showInformationMessage(
          "Save the file before showing SVN blame."
        );
      }
      return;
    }

    if (this.records.has(file)) {
      this.render(editor);
      return;
    }
    if (this.pendingBlame.has(file)) return;

    const documentVersion = document.version;
    const repository = await this.sourceControlManager.getRepositoryFromUri(
      document.uri
    );
    if (
      !repository ||
      this.disposed ||
      document.isClosed ||
      document.isDirty ||
      document.version !== documentVersion
    ) {
      return;
    }

    const generation = this.nextRequestGeneration(file);
    const controller = new AbortController();
    const request: PendingBlame = { repository, controller, generation };
    this.pendingBlame.set(file, request);

    try {
      const lines = await repository.blame(file, controller.signal);
      if (
        this.disposed ||
        controller.signal.aborted ||
        this.pendingBlame.get(file) !== request ||
        this.requestGenerations.get(file) !== generation ||
        document.isClosed ||
        document.isDirty ||
        document.version !== documentVersion
      ) {
        return;
      }

      this.records.set(file, {
        repository,
        lines,
        logs: new Map(),
        decorations: []
      });
      this.render(editor);
      await this.onSelection(editor);
    } catch (error) {
      if (
        !(error instanceof SvnCancellationError) &&
        !controller.signal.aborted &&
        this.pendingBlame.get(file) === request
      ) {
        window.showErrorMessage(
          `SVN blame failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      if (this.pendingBlame.get(file) === request) {
        this.pendingBlame.delete(file);
      }
    }
  }

  private clear(file: string): void {
    this.nextRequestGeneration(file);
    this.pendingBlame.get(file)?.controller.abort();
    this.pendingBlame.delete(file);
    this.cancelSelection(file);

    const record = this.records.get(file);
    if (!record) return;

    record.activeDecoration?.dispose();
    for (const decoration of record.decorations) decoration.dispose();
    this.records.delete(file);
  }

  private clearRepository(repository: Repository): void {
    const files = new Set<string>();

    for (const [file, record] of this.records) {
      if (record.repository === repository) files.add(file);
    }
    for (const [file, request] of this.pendingBlame) {
      if (request.repository === repository) files.add(file);
    }

    for (const file of files) this.clear(file);
  }

  private visibleLines(
    editor: TextEditor,
    record: BlameRecord
  ): SvnBlameLine[] {
    if (!editor.visibleRanges.length) return record.lines;
    return record.lines.filter(line => {
      const zeroBased = line.line - 1;
      return editor.visibleRanges.some(
        range =>
          zeroBased >= Math.max(0, range.start.line - VIEWPORT_BUFFER) &&
          zeroBased <= range.end.line + VIEWPORT_BUFFER
      );
    });
  }

  private render(editor: TextEditor): void {
    const record = this.records.get(editor.document.uri.fsPath);
    if (!record) return;

    for (const decoration of record.decorations) decoration.dispose();
    record.decorations = [];

    const showGutter = workspace
      .getConfiguration("svn", editor.document.uri)
      .get<boolean>("blame.gutter", true);
    if (!showGutter) return;

    const byRevision = new Map<string, SvnBlameLine[]>();
    for (const line of this.visibleLines(editor, record)) {
      const list = byRevision.get(line.revision) ?? [];
      list.push(line);
      byRevision.set(line.revision, list);
    }

    for (const [revision, lines] of byRevision) {
      const decoration = window.createTextEditorDecorationType({
        gutterIconPath: iconForRevision(revision),
        gutterIconSize: "contain"
      });
      record.decorations.push(decoration);
      editor.setDecorations(
        decoration,
        lines.map(line => ({
          range: new Range(line.line - 1, 0, line.line - 1, 0),
          hoverMessage: hoverText(line, record.logs.get(revision))
        }))
      );
    }
  }

  private async onSelection(editor: TextEditor): Promise<void> {
    const file = editor.document.uri.fsPath;
    const record = this.records.get(file);
    if (!record) return;

    this.cancelSelection(file);
    const generation = this.selectionGenerations.get(file) ?? 0;
    const selectedLine = editor.selection.active.line + 1;
    const blame = record.lines.find(line => line.line === selectedLine);

    record.activeDecoration?.dispose();
    record.activeDecoration = undefined;
    if (!blame) return;

    const isCurrent = () =>
      !this.disposed &&
      this.records.get(file) === record &&
      this.selectionGenerations.get(file) === generation &&
      !editor.document.isClosed &&
      editor.selection.active.line + 1 === selectedLine;

    const setActive = () => {
      if (!isCurrent()) return;

      record.activeDecoration?.dispose();
      const log = record.logs.get(blame.revision);
      record.activeDecoration = window.createTextEditorDecorationType({
        after: {
          contentText: `  r${blame.revision}${blame.author ? ` · ${blame.author}` : ""}`,
          color: new ThemeColor("editorCodeLens.foreground"),
          margin: "0 0 0 2em"
        }
      });

      const end = editor.document.lineAt(blame.line - 1).range.end;
      editor.setDecorations(record.activeDecoration, [
        {
          range: new Range(end, end),
          hoverMessage: hoverText(blame, log)
        }
      ]);
    };

    setActive();

    if (record.logs.has(blame.revision) || !/^\d+$/.test(blame.revision)) {
      return;
    }

    const controller = new AbortController();
    this.pendingLog.set(file, controller);

    try {
      const entry = await record.repository.blameLog(
        file,
        blame.revision,
        controller.signal
      );
      if (!entry || controller.signal.aborted || !isCurrent()) return;

      record.logs.set(blame.revision, entry.msg || "");
      this.render(editor);
      setActive();
    } catch (error) {
      if (
        !(error instanceof SvnCancellationError) &&
        !controller.signal.aborted
      ) {
        // Blame metadata remains useful when a log lookup is unavailable.
      }
    } finally {
      if (this.pendingLog.get(file) === controller) {
        this.pendingLog.delete(file);
      }
    }
  }

  private onDocumentChange(event: TextDocumentChangeEvent): void {
    const file = event.document.uri.fsPath;
    const record = this.records.get(file);
    if (!record || !event.contentChanges.length) return;

    this.cancelSelection(file);
    record.activeDecoration?.dispose();
    record.activeDecoration = undefined;

    record.lines = shiftBlameLines(
      record.lines,
      event.contentChanges.map(change => ({
        startLine: change.range.start.line,
        startCharacter: change.range.start.character,
        endLine: change.range.end.line,
        endCharacter: change.range.end.character,
        insertedLineCount: (change.text.match(/\n/g) ?? []).length
      }))
    );

    const editor = window.visibleTextEditors.find(
      value => value.document.uri.fsPath === file
    );
    if (editor) {
      this.render(editor);
      void this.onSelection(editor);
    }
  }
}
