import {
  commands,
  Disposable,
  TextDocumentChangeEvent,
  TextEditor,
  window,
  workspace
} from "vscode";
import { BlameDecorations } from "./blameDecorations";
import { shiftBlameLines } from "./blameModel";
import { SvnBlameLine } from "./parser/blameParser";
import { Repository } from "./repository";
import { SourceControlManager } from "./source_control_manager";
import { SvnCancellationError } from "./svnProcess";

interface BlameRecord {
  repository: Repository;
  lines: SvnBlameLine[];
  logs: Map<string, string>;
  decorations: BlameDecorations;
}

interface PendingBlame {
  repository?: Repository;
  controller: AbortController;
  generation: number;
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

    const existing = this.records.get(file);
    if (existing) {
      existing.decorations.renderGutter(editor, existing.lines, existing.logs);
      return;
    }
    if (this.pendingBlame.has(file)) return;

    const documentVersion = document.version;
    const generation = this.nextRequestGeneration(file);
    const controller = new AbortController();
    const request: PendingBlame = { controller, generation };
    this.pendingBlame.set(file, request);

    try {
      const repository = await this.sourceControlManager.getRepositoryFromUri(
        document.uri
      );
      if (
        !repository ||
        !this.isBlameRequestCurrent(
          file,
          request,
          documentVersion,
          document.version,
          document.isClosed,
          document.isDirty
        )
      ) {
        return;
      }

      request.repository = repository;
      const lines = await repository.blame(file, controller.signal);
      if (
        !this.isBlameRequestCurrent(
          file,
          request,
          documentVersion,
          document.version,
          document.isClosed,
          document.isDirty
        )
      ) {
        return;
      }

      const record: BlameRecord = {
        repository,
        lines,
        logs: new Map(),
        decorations: new BlameDecorations()
      };
      this.records.set(file, record);
      record.decorations.renderGutter(editor, record.lines, record.logs);
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

  private isBlameRequestCurrent(
    file: string,
    request: PendingBlame,
    initialVersion: number,
    currentVersion: number,
    documentClosed: boolean,
    documentDirty: boolean
  ): boolean {
    return (
      !this.disposed &&
      !request.controller.signal.aborted &&
      this.pendingBlame.get(file) === request &&
      this.requestGenerations.get(file) === request.generation &&
      !documentClosed &&
      !documentDirty &&
      currentVersion === initialVersion
    );
  }

  private clear(file: string): void {
    this.nextRequestGeneration(file);
    this.pendingBlame.get(file)?.controller.abort();
    this.pendingBlame.delete(file);
    this.cancelSelection(file);

    this.records.get(file)?.decorations.dispose();
    this.records.delete(file);

    // Missing generation entries also invalidate any async continuation, while
    // avoiding one retained path per document closed during a long VS Code session.
    this.requestGenerations.delete(file);
    this.selectionGenerations.delete(file);
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

  private render(editor: TextEditor): void {
    const record = this.records.get(editor.document.uri.fsPath);
    if (!record) return;
    record.decorations.renderGutter(editor, record.lines, record.logs);
  }

  private async onSelection(editor: TextEditor): Promise<void> {
    const file = editor.document.uri.fsPath;
    const record = this.records.get(file);
    if (!record) return;

    this.cancelSelection(file);
    const generation = this.selectionGenerations.get(file) ?? 0;
    const selectedLine = editor.selection.active.line + 1;
    const blame = record.lines.find(line => line.line === selectedLine);

    record.decorations.clearActive();
    if (!blame) return;

    const isCurrent = () =>
      !this.disposed &&
      this.records.get(file) === record &&
      this.selectionGenerations.get(file) === generation &&
      !editor.document.isClosed &&
      editor.selection.active.line + 1 === selectedLine;

    const renderActive = () => {
      if (!isCurrent()) return;
      record.decorations.renderActive(
        editor,
        blame,
        record.logs.get(blame.revision)
      );
    };

    renderActive();

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
      record.decorations.renderGutter(editor, record.lines, record.logs);
      renderActive();
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
    record.decorations.clearActive();

    record.lines = shiftBlameLines(
      record.lines,
      event.contentChanges.map(change => ({
        startLine: change.range.start.line,
        startCharacter: change.range.start.character,
        endLine: change.range.end.line,
        endCharacter: change.range.end.character,
        insertedLineCount: (change.text.match(/\n/g) ?? []).length,
        preserveStartLine:
          change.range.isEmpty &&
          /^(?:\r?\n)+$/.test(change.text) &&
          event.document.lineAt(change.range.start.line).text.length ===
            change.range.start.character &&
          event.document.lineAt(change.range.start.line + 1).text.length === 0
      }))
    );

    const editor = window.visibleTextEditors.find(
      value => value.document.uri.fsPath === file
    );
    if (editor) {
      record.decorations.renderGutter(editor, record.lines, record.logs);
      void this.onSelection(editor);
    }
  }
}
