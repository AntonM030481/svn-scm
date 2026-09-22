import {
  Disposable,
  Range,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  Uri,
  window,
  workspace
} from "vscode";
import { SvnBlameLine } from "./parser/blameParser";

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

export class BlameDecorations implements Disposable {
  private gutter: TextEditorDecorationType[] = [];
  private active?: TextEditorDecorationType;

  public renderGutter(
    editor: TextEditor,
    lines: readonly SvnBlameLine[],
    logs: ReadonlyMap<string, string>
  ): void {
    this.clearGutter();

    const showGutter = workspace
      .getConfiguration("svn", editor.document.uri)
      .get<boolean>("blame.gutter", true);
    if (!showGutter) return;

    const visible = lines.filter(line => {
      const zeroBased = line.line - 1;
      return editor.visibleRanges.length === 0 ||
        editor.visibleRanges.some(
          range =>
            zeroBased >= Math.max(0, range.start.line - VIEWPORT_BUFFER) &&
            zeroBased <= range.end.line + VIEWPORT_BUFFER
        );
    });

    const byRevision = new Map<string, SvnBlameLine[]>();
    for (const line of visible) {
      const entries = byRevision.get(line.revision) ?? [];
      entries.push(line);
      byRevision.set(line.revision, entries);
    }

    for (const [revision, revisionLines] of byRevision) {
      const decoration = window.createTextEditorDecorationType({
        gutterIconPath: iconForRevision(revision),
        gutterIconSize: "contain"
      });
      this.gutter.push(decoration);
      editor.setDecorations(
        decoration,
        revisionLines.map(line => ({
          range: new Range(line.line - 1, 0, line.line - 1, 0),
          hoverMessage: hoverText(line, logs.get(revision))
        }))
      );
    }
  }

  public renderActive(
    editor: TextEditor,
    line: SvnBlameLine,
    log?: string
  ): void {
    this.clearActive();

    const zeroBased = line.line - 1;
    if (zeroBased < 0 || zeroBased >= editor.document.lineCount) return;

    this.active = window.createTextEditorDecorationType({
      after: {
        contentText: `  r${line.revision}${line.author ? ` · ${line.author}` : ""}`,
        color: new ThemeColor("editorCodeLens.foreground"),
        margin: "0 0 0 2em"
      }
    });

    const end = editor.document.lineAt(zeroBased).range.end;
    editor.setDecorations(this.active, [
      {
        range: new Range(end, end),
        hoverMessage: hoverText(line, log)
      }
    ]);
  }

  public clearActive(): void {
    this.active?.dispose();
    this.active = undefined;
  }

  public dispose(): void {
    this.clearActive();
    this.clearGutter();
  }

  private clearGutter(): void {
    for (const decoration of this.gutter) decoration.dispose();
    this.gutter = [];
  }
}
