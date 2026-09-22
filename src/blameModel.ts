import { SvnBlameLine } from "./parser/blameParser";

export interface BlameLineChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  insertedText: string;
}

export function shiftBlameLines(
  lines: SvnBlameLine[],
  changes: BlameLineChange[]
): SvnBlameLine[] {
  let current = lines.map(line => ({ ...line }));

  for (const change of [...changes].sort((a, b) => b.startLine - a.startLine)) {
    const start = change.startLine + 1;
    const end = change.endLine + 1;
    const insertedLineCount = (change.insertedText.match(/\n/g) ?? []).length;
    const insertedEndsWithNewline = change.insertedText.endsWith("\n");
    const removedLineBreaks = change.endLine - change.startLine;
    const delta = insertedLineCount - removedLineBreaks;
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
            if (change.startCharacter === 0 && insertedLineCount > 0) {
              return insertedEndsWithNewline
                ? [{ ...line, line: line.line + insertedLineCount }]
                : [];
            }
            return [line];
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

        const untouchedEndLine =
          change.insertedText.length === 0 || insertedEndsWithNewline;

        if (
          !untouchedEndLine ||
          (change.startCharacter > 0 && insertedLineCount === 0)
        ) {
          return [];
        }
        return [{ ...line, line: line.line + delta }];
      }

      return [{ ...line, line: line.line + delta }];
    });
  }

  return current;
}
