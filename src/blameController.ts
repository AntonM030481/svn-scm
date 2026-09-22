import {
  commands,
  Disposable,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditor,
  window,
  workspace
} from "vscode";
import { BlameSession } from "./blameSession";
import { Repository } from "./repository";
import { SourceControlManager } from "./source_control_manager";
import { SvnCancellationError } from "./svnProcess";

interface PendingBlame {
  repository?: Repository;
  controller: AbortController;
}

export class BlameController implements Disposable {
  private readonly sessions = new Map<string, BlameSession>();
  private readonly pendingBlame = new Map<string, PendingBlame>();
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
      window.onDidChangeTextEditorSelection(
        event =>
          void this.sessionFor(event.textEditor)?.select(event.textEditor)
      ),
      window.onDidChangeTextEditorVisibleRanges(event =>
        this.sessionFor(event.textEditor)?.render(event.textEditor)
      ),
      workspace.onDidChangeTextDocument(event =>
        this.onDocumentChange(event)
      ),
      workspace.onDidSaveTextDocument(document =>
        this.restartAutoBlame(document)
      ),
      workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("svn.blame.gutter")) {
          for (const editor of window.visibleTextEditors) {
            this.sessionFor(editor)?.render(editor);
          }
        }
        if (event.affectsConfiguration("svn.blame.auto")) {
          void this.onActiveEditor(window.activeTextEditor);
        }
      }),
      workspace.onDidCloseTextDocument(document =>
        this.clear(document.uri.fsPath)
      ),
      sourceControlManager.onDidCloseRepository(repository =>
        this.clearRepository(repository)
      )
    );

    void this.onActiveEditor(window.activeTextEditor);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const disposable of this.disposables.splice(0)) disposable.dispose();

    const files = new Set([
      ...this.sessions.keys(),
      ...this.pendingBlame.keys()
    ]);
    for (const file of files) this.clear(file);
  }

  private sessionFor(editor: TextEditor): BlameSession | undefined {
    return this.sessions.get(editor.document.uri.fsPath);
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
    if (this.sessions.has(file) || this.pendingBlame.has(file)) {
      this.clear(file);
    } else {
      await this.show(editor, true);
    }
  }

  private async show(
    editor: TextEditor,
    interactive: boolean
  ): Promise<void> {
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

    const existing = this.sessions.get(file);
    if (existing) {
      existing.render(editor);
      return;
    }
    if (this.pendingBlame.has(file)) return;

    const request: PendingBlame = { controller: new AbortController() };
    const documentVersion = document.version;
    this.pendingBlame.set(file, request);

    try {
      let repository = await this.sourceControlManager.getRepositoryFromUri(
        document.uri
      );
      if (
        !repository ||
        !this.isRequestCurrent(file, request, document, documentVersion)
      ) {
        return;
      }

      request.repository = repository;

      if (!interactive && repository.isInitialStatusPending) {
        await repository.initialStatusSettled;
        if (!this.isRequestCurrent(file, request, document, documentVersion)) {
          return;
        }

        repository = await this.sourceControlManager.getRepositoryFromUri(
          document.uri
        );
        if (
          !repository ||
          !this.isRequestCurrent(file, request, document, documentVersion)
        ) {
          return;
        }
        request.repository = repository;
      }

      const lines = await repository.blame(file, request.controller.signal);
      if (!this.isRequestCurrent(file, request, document, documentVersion)) {
        return;
      }

      const session = new BlameSession(repository, lines);
      this.sessions.set(file, session);
      session.render(editor);
      await session.select(editor);
    } catch (error) {
      if (
        !(error instanceof SvnCancellationError) &&
        !request.controller.signal.aborted &&
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

  private onDocumentChange(event: TextDocumentChangeEvent): void {
    const file = event.document.uri.fsPath;
    const pending = this.pendingBlame.get(file);
    if (pending) {
      pending.controller.abort();
      this.pendingBlame.delete(file);
    }

    const session = this.sessions.get(file);
    if (session) {
      session.applyDocumentChange(
        event,
        window.visibleTextEditors.find(
          editor => editor.document === event.document
        )
      );
    }

    if (!event.document.isDirty) {
      this.restartAutoBlame(event.document);
    }
  }

  private restartAutoBlame(document: TextDocument): void {
    const editor = window.activeTextEditor;
    if (
      editor?.document !== document ||
      !workspace
        .getConfiguration("svn", document.uri)
        .get<boolean>("blame.auto")
    ) {
      return;
    }

    this.clear(document.uri.fsPath);
    void this.show(editor, false);
  }

  private isRequestCurrent(
    file: string,
    request: PendingBlame,
    document: TextDocument,
    initialVersion: number
  ): boolean {
    return (
      !this.disposed &&
      !request.controller.signal.aborted &&
      this.pendingBlame.get(file) === request &&
      !document.isClosed &&
      !document.isDirty &&
      document.version === initialVersion
    );
  }

  private clear(file: string): void {
    this.pendingBlame.get(file)?.controller.abort();
    this.pendingBlame.delete(file);

    this.sessions.get(file)?.dispose();
    this.sessions.delete(file);
  }

  private clearRepository(repository: Repository): void {
    const files = new Set<string>();

    for (const [file, session] of this.sessions) {
      if (session.repository === repository) files.add(file);
    }
    for (const [file, request] of this.pendingBlame) {
      if (request.repository === repository) files.add(file);
    }

    for (const file of files) this.clear(file);
  }
}
