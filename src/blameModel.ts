import { SvnBlameLine } from "./parser/blameParser";

export interface BlameLineChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
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
    const lastConsumedLine =
      change.endCharacter === 0 && change.endLine > change.startLine
        ? end - 1
        : end;

    current = current.flatMap(line => {
      if (line.line <= start) {
        return [line];
      }
      if (line.line <= lastConsumedLine) {
        return [];
      }
      return [{ ...line, line: line.line + delta }];
    });
  }

  return current;
}
