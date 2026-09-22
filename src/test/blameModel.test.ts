import * as assert from "assert";
import { shiftBlameLines } from "../blameModel";

suite("blame line mapping", () => {
  const lines = [
    { line: 1, revision: "1" },
    { line: 2, revision: "2" },
    { line: 3, revision: "3" },
    { line: 4, revision: "4" }
  ];

  test("shifts following blame lines after insertion", () => {
    assert.deepStrictEqual(
      shiftBlameLines(lines, [
        { startLine: 1, endLine: 1, insertedLineCount: 2 }
      ]).map(x => x.line),
      [1, 2, 5, 6]
    );
  });

  test("drops consumed lines but preserves and shifts following lines", () => {
    const shifted = shiftBlameLines(lines, [
      { startLine: 1, endLine: 2, insertedLineCount: 0 }
    ]);

    assert.deepStrictEqual(
      shifted.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [2, "2"],
        [3, "4"]
      ]
    );
  });

  test("replaces a multi-line range without dropping the following line", () => {
    const shifted = shiftBlameLines(lines, [
      { startLine: 0, endLine: 2, insertedLineCount: 1 }
    ]);

    assert.deepStrictEqual(
      shifted.map(x => [x.line, x.revision]),
      [
        [1, "1"],
        [3, "4"]
      ]
    );
  });
});
