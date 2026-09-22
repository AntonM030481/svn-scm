import { Disposable, TextDocumentChangeEvent, TextEditor } from "vscode";
import { BlameDecorations } from "./blameDecorations";
import { shiftBlameLines } from "./blameModel";
import { SvnBlameLine } from "./parser/blameParser";
import { Repository } from "./repository";
import { SvnCancellationError } from "./svnProcess";

export class BlameSession implements Disposable {
  private readonly logs = new Map<string, string>();
  private readonly decorations = new BlameDecorations();
  private selectionGeneration = 0;
  private pendingLog?: AbortController;
  private disposed = false;

  constructor(
    public readonly repository: Repository,
    private lines: SvnBlameLine[]
  ) {}

  public render(editor: TextEditor): void {
    if (this.disposed) return;
    this.decorations.renderGutter(editor, this.lines, this.logs);
  }

  public async select(editor: TextEditor): Promise<void> {
    if (this.disposed) return;

    this.cancelSelection();
    const generation = this.selectionGeneration;
    const selectedLine = editor.selection.active.line + 1;
    const blame = this.lines.find(line => line.line === selectedLine);

    this.decorations.clearActive();
    if (!blame) return;

    const isCurrent = () =>
      !this.disposed &&
      this.selectionGeneration === generation &&
      !editor.document.isClosed &&
      editor.selection.active.line + 1 === selectedLine;

    const renderActive = () => {
      if (!isCurrent()) return;
      this.decorations.renderActive(
        editor,
        blame,
        this.logs.get(blame.revision)
      );
    };

    renderActive();

    if (this.logs.has(blame.revision) || !/^\d+$/.test(blame.revision)) {
      return;
    }

    const controller = new AbortController();
    this.pendingLog = controller;

    try {
      const entry = await this.repository.blameLog(
        editor.document.uri.fsPath,
        blame.revision,
        controller.signal
      );
      if (!entry || controller.signal.aborted || !isCurrent()) return;

      this.logs.set(blame.revision, entry.msg || "");
      this.render(editor);
      renderActive();
    } catch (error) {
      if (
        !(error instanceof SvnCancellationError) &&
        !controller.signal.aborted
      ) {
        // Per-line blame remains useful even if revision details are unavailable.
      }
    } finally {
      if (this.pendingLog === controller) {
        this.pendingLog = undefined;
      }
    }
  }

  public applyDocumentChange(
    event: TextDocumentChangeEvent,
    editor?: TextEditor
  ): void {
    if (this.disposed || !event.contentChanges.length) return;

    this.cancelSelection();
    this.decorations.clearActive();

    this.lines = shiftBlameLines(
      this.lines,
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

    if (editor) {
      this.render(editor);
      void this.select(editor);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSelection();
    this.decorations.dispose();
  }

  private cancelSelection(): void {
    this.selectionGeneration++;
    this.pendingLog?.abort();
    this.pendingLog = undefined;
  }
}
