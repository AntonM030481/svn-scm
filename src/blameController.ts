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
import { Repository } from "./repository";
import { SvnBlameLine } from "./parser/blameParser";
import { shiftBlameLines } from "./blameModel";
import { cancelDebounces, debounce } from "./decorators";

interface BlameRecord {
  repository: Repository;
  lines: SvnBlameLine[];
  logs: Map<string, string>;
  loadingLogs: Set<string>;
  decorations: TextEditorDecorationType[];
  activeDecoration?: TextEditorDecorationType;
}

interface PendingBlame {
  repository: Repository;
  controller: AbortController;
  documentVersion: number;
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
  private readonly pendingBlames = new Map<string, PendingBlame>();
  private readonly visibleRangeTimers = new Map<
    TextEditor,
    ReturnType<typeof setTimeout>
  >();
  private activeLogRequest?: {
    file: string;
    revision: string;
    controller: AbortController;
  };
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  constructor(private readonly sourceControlManager: SourceControlManager) {
    this.disposables.push(
      commands.registerCommand("svn.blame.show", () => this.showActive()),
      commands.registerCommand("svn.blame.hide", () => this.hideActive()),
      commands.registerCommand("svn.blame.toggle", () => this.toggleActive()),
      window.onDidChangeActiveTextEditor(
        editor => void this.onActiveEditor(editor)
      ),
      window.onDidChangeTextEditorSelection(event =>
        this.onSelectionChanged(event.textEditor)
      ),
      window.onDidChangeTextEditorVisibleRanges(event =>
        this.onVisibleRangesChange(event.textEditor)
      ),
      workspace.onDidChangeTextDocument(event => this.onDocumentChange(event)),
      workspace.onDidCloseTextDocument(document =>
        this.clear(document.uri.fsPath)
      ),
      sourceControlManager.onDidCloseRepository(repository =>
        this.onRepositoryClosed(repository)
      )
    );

    void this.onActiveEditor(window.activeTextEditor);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelDebounces(this);
    for (const timer of this.visibleRangeTimers.values()) {
      clearTimeout(timer);
    }
    this.visibleRangeTimers.clear();
    this.activeLogRequest?.controller.abort();
    this.activeLogRequest = undefined;
    for (const pending of this.pendingBlames.values()) {
      pending.controller.abort();
    }
    this.pendingBlames.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    for (const file of [...this.records.keys()]) this.clear(file);
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
    if (editor) await this.show(editor);
  }

  private hideActive(): void {
    const editor = window.activeTextEditor;
    if (editor) this.clear(editor.document.uri.fsPath);
  }

  private async toggleActive(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return;
    if (this.records.has(editor.document.uri.fsPath)) {
      this.clear(editor.document.uri.fsPath);
    } else {
      await this.show(editor);
    }
  }

  private async show(editor: TextEditor, notifyDirty = true): Promise<void> {
    const file = editor.document.uri.fsPath;
    if (this.records.has(file)) {
      this.render(editor);
      return;
    }
    if (this.pendingBlames.has(file)) {
      return;
    }
    if (editor.document.isDirty) {
      if (notifyDirty) {
        window.showInformationMessage(
          "Save the file before showing SVN blame."
        );
      }
      return;
    }

    const repository = await this.sourceControlManager.getRepositoryFromUri(
      editor.document.uri
    );
    if (!repository || this.disposed) return;

    const controller = new AbortController();
    const pending: PendingBlame = {
      repository,
      controller,
      documentVersion: editor.document.version
    };
    this.pendingBlames.set(file, pending);

    try {
      const lines = await repository.blame(file, controller.signal);
      if (
        this.disposed ||
        controller.signal.aborted ||
        this.pendingBlames.get(file) !== pending ||
        editor.document.isClosed
      ) {
        return;
      }
      if (
        editor.document.isDirty ||
        editor.document.version !== pending.documentVersion
      ) {
        if (notifyDirty) {
          window.showInformationMessage(
            "The file changed while SVN blame was running. Save it and show blame again."
          );
        }
        return;
      }

      this.records.set(file, {
        repository,
        lines,
        logs: new Map(),
        loadingLogs: new Set(),
        decorations: []
      });
      this.render(editor);
      await this.onSelection(editor);
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        window.showErrorMessage(
          `SVN blame failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      if (this.pendingBlames.get(file) === pending) {
        this.pendingBlames.delete(file);
      }
    }
  }

  private clear(file: string): void {
    const pending = this.pendingBlames.get(file);
    if (pending) {
      pending.controller.abort();
      this.pendingBlames.delete(file);
    }
    if (this.activeLogRequest?.file === file) {
      this.activeLogRequest.controller.abort();
      this.activeLogRequest = undefined;
    }

    const record = this.records.get(file);
    if (!record) return;
    record.activeDecoration?.dispose();
    for (const decoration of record.decorations) decoration.dispose();
    this.records.delete(file);
  }

  private onRepositoryClosed(repository: Repository): void {
    for (const [file, pending] of [...this.pendingBlames]) {
      if (pending.repository === repository) {
        this.clear(file);
      }
    }
    for (const [file, record] of [...this.records]) {
      if (record.repository === repository) {
        this.clear(file);
      }
    }
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

  @debounce(75)
  private onSelectionChanged(editor: TextEditor): void {
    void this.onSelection(editor);
  }

  private onVisibleRangesChange(editor: TextEditor): void {
    const existing = this.visibleRangeTimers.get(editor);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      if (this.visibleRangeTimers.get(editor) !== timer) {
        return;
      }
      this.visibleRangeTimers.delete(editor);
      this.render(editor);
    }, 50);
    this.visibleRangeTimers.set(editor, timer);
  }

  private async onSelection(editor: TextEditor): Promise<void> {
    const file = editor.document.uri.fsPath;
    const record = this.records.get(file);
    if (!record) return;

    const selectedLine = editor.selection.active.line + 1;
    const blame = record.lines.find(line => line.line === selectedLine);
    record.activeDecoration?.dispose();
    record.activeDecoration = undefined;
    if (!blame) return;

    const setActive = () => {
      if (
        this.records.get(file) !== record ||
        editor.document.isClosed ||
        editor.selection.active.line + 1 !== blame.line
      ) {
        return;
      }
      record.activeDecoration?.dispose();
      const log = record.logs.get(blame.revision);
      record.activeDecoration = window.createTextEditorDecorationType({
        after: {
          contentText: `  r${blame.revision}${blame.author ? ` · ${blame.author}` : ""}`,
          color: new ThemeColor("editorCodeLens.foreground"),
          margin: "0 0 0 2em"
        }
      });
      editor.setDecorations(record.activeDecoration, [
        {
          range: new Range(
            editor.document.lineAt(blame.line - 1).range.end,
            editor.document.lineAt(blame.line - 1).range.end
          ),
          hoverMessage: hoverText(blame, log)
        }
      ]);
    };

    setActive();

    if (record.logs.has(blame.revision) || !/^\\d+$/.test(blame.revision)) {
      return;
    }

    const activeRequest = this.activeLogRequest;
    if (
      activeRequest?.file === file &&
      activeRequest.revision === blame.revision
    ) {
      return;
    }
    activeRequest?.controller.abort();

    const controller = new AbortController();
    this.activeLogRequest = {
      file,
      revision: blame.revision,
      controller
    };
    record.loadingLogs.add(blame.revision);

    try {
      const entry = await record.repository.blameLog(
        file,
        blame.revision,
        controller.signal
      );
      if (
        controller.signal.aborted ||
        !entry ||
        this.records.get(file) !== record
      ) {
        return;
      }
      record.logs.set(blame.revision, entry.msg || "");
      this.render(editor);
      setActive();
    } catch {
      // Blame metadata remains useful when a log lookup is unavailable.
    } finally {
      record.loadingLogs.delete(blame.revision);
      if (this.activeLogRequest?.controller === controller) {
        this.activeLogRequest = undefined;
      }
    }
  }

  private onDocumentChange(event: TextDocumentChangeEvent): void {
    const record = this.records.get(event.document.uri.fsPath);
    if (!record || !event.contentChanges.length) return;

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
      value => value.document.uri.fsPath === event.document.uri.fsPath
    );
    if (editor) this.render(editor);
  }
}
