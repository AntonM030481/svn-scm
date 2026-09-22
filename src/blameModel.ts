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
    const insertion =
      change.startLine === change.endLine &&
      change.startCharacter === change.endCharacter;

    current = current.flatMap(line => {
      if (line.line < start) {
        return [line];
      }

      if (change.startLine === change.endLine) {
        if (line.line === start) {
          if (insertion) {
            return [
              change.startCharacter === 0 && change.insertedLineCount > 0
                ? { ...line, line: line.line + change.insertedLineCount }
                : line
            ];
          }
          return change.startCharacter > 0 ? [line] : [];
        }
        return [{ ...line, line: line.line + delta }];
      }

      if (line.line === start) {
        return change.startCharacter > 0 ? [line] : [];
      }

      if (line.line < end) {
        return [];
      }

      if (line.line === end) {
        if (change.endCharacter !== 0) {
          return [];
        }
        if (change.startCharacter > 0 && change.insertedLineCount === 0) {
          return [];
        }
        return [{ ...line, line: line.line + delta }];
      }

      return [{ ...line, line: line.line + delta }];
    });
  }

  return current;
}
