import { SvnBlameLine } from "./parser/blameParser";

export interface BlameLineChange {
  startLine: number;
  endLine: number;
  insertedLineCount: number;
}

export function shiftBlameLines(
  lines: SvnBlameLine[],
  changes: BlameLineChange[]
): SvnBlameLine[] {
  let current = lines.map(line => ({ ...line }));

  for (const change of [...changes].sort((a, b) => b.startLine - a.startLine)) {
    const start = change.startLine + 1;
    const end = change.endLine + 1;
    const removedLineBreaks = change.endLine - change.startLine;
    const delta = change.insertedLineCount - removedLineBreaks;

    current = current.flatMap(line => {
      if (line.line <= start) {
        return [line];
      }
      if (line.line <= end) {
        return [];
      }
      return [{ ...line, line: line.line + delta }];
    });
  }

  return current;
}
