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
      shiftBlameLines(lines, [{ startLine: 1, endLine: 1, insertedLineCount: 2 }]).map(x => x.line),
      [1, 2, 5, 6]
    );
  });

  test("drops deleted lines and shifts following lines", () => {
    assert.deepStrictEqual(
      shiftBlameLines(lines, [{ startLine: 1, endLine: 3, insertedLineCount: 0 }]).map(x => x.line),
      [1, 2]
    );
  });
});
