import { SvnBlameLine } from "./parser/blameParser";

export interface BlameLineChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  insertedLineCount: number;
  startLineShift?: number;
}

export function shiftBlameLines(
  lines: SvnBlameLine[],
  changes: BlameLineChange[]
): SvnBlameLine[] {
  let current = lines.map(line => ({ ...line }));

  for (const change of [...changes].sort((a, b) => b.startLine - a.startLine)) {
    const removedLineBreaks = change.endLine - change.startLine;
    const delta = change.insertedLineCount - removedLineBreaks;

    current = current.flatMap(line => {
      const zeroBased = line.line - 1;

      if (zeroBased < change.startLine) {
        return [line];
      }

      if (
        zeroBased === change.startLine &&
        change.startLineShift !== undefined
      ) {
        return [{ ...line, line: line.line + change.startLineShift }];
      }

      const survivesAfterRange =
        zeroBased > change.endLine ||
        (zeroBased === change.endLine &&
          change.endLine > change.startLine &&
          change.endCharacter === 0 &&
          change.startCharacter === 0);

      if (!survivesAfterRange) {
        // The original line was touched by the edit. Do not attribute the
        // changed in-memory text to the old revision.
        return [];
      }

      return [{ ...line, line: line.line + delta }];
    });
  }

  return current;
}
