import * as assert from "assert";
import { shiftBlameLines } from "../blameModel";

suite("blame line mapping", () => {
  const lines = [
    { line: 1, revision: "1" },
    { line: 2, revision: "2" },
    { line: 3, revision: "3" },
    { line: 4, revision: "4" }
  ];

  test("shifts untouched lines after insertion at a line boundary", () => {
    const mapped = shiftBlameLines(lines, [
      {
        startLine: 1,
        startCharacter: 0,
        endLine: 1,
        endCharacter: 0,
        insertedLineCount: 2
      }
    ]);

    assert.deepStrictEqual(
      mapped.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [4, "2"],
        [5, "3"],
        [6, "4"]
      ]
    );
  });

  test("preserves the line after a full-line deletion", () => {
    const mapped = shiftBlameLines(lines, [
      {
        startLine: 1,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 0,
        insertedLineCount: 0
      }
    ]);

    assert.deepStrictEqual(
      mapped.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [2, "3"],
        [3, "4"]
      ]
    );
  });

  test("drops both endpoint attributions when deleting only a newline", () => {
    const mapped = shiftBlameLines(lines, [
      {
        startLine: 1,
        startCharacter: 8,
        endLine: 2,
        endCharacter: 0,
        insertedLineCount: 0
      }
    ]);

    assert.deepStrictEqual(
      mapped.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [3, "4"]
      ]
    );
  });

  test("drops attribution for an edited line without shifting other lines", () => {
    const mapped = shiftBlameLines(lines, [
      {
        startLine: 1,
        startCharacter: 2,
        endLine: 1,
        endCharacter: 4,
        insertedLineCount: 0
      }
    ]);

    assert.deepStrictEqual(
      mapped.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [3, "3"],
        [4, "4"]
      ]
    );
  });
});
