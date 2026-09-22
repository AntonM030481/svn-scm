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
        startLineShift: this.getStartLineShift(event, change)
      }))
    );

    if (editor) {
      this.render(editor);
      void this.select(editor);
    }
  }

  private getStartLineShift(
    event: TextDocumentChangeEvent,
    change: TextDocumentChangeEvent["contentChanges"][number]
  ): number | undefined {
    if (event.contentChanges.length !== 1 || !change.range.isEmpty) {
      return undefined;
    }

    const insertedLineCount = (change.text.match(/\n/g) ?? []).length;
    if (insertedLineCount === 0) {
      return undefined;
    }

    // A newline-terminated insertion at column zero adds complete lines before
    // the original line, so its old attribution survives but moves down.
    if (
      change.range.start.character === 0 &&
      /\r?\n$/.test(change.text)
    ) {
      return insertedLineCount;
    }

    // An insertion beginning with a newline at EOL leaves the original line
    // text untouched (including auto-indent payloads such as "\n    ").
    if (
      /^\r?\n/.test(change.text) &&
      event.document.lineAt(change.range.start.line).text.length ===
        change.range.start.character
    ) {
      return 0;
    }

    return undefined;
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
