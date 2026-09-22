import * as assert from "assert";
import { parseBlameXml } from "../parser/blameParser";

suite("blame parser", () => {
  test("parses revision metadata for each line", async () => {
    const lines = await parseBlameXml(`<?xml version="1.0"?>
<blame>
  <target path="file.txt">
    <entry line-number="1"><commit revision="12"><author>alice</author><date>2026-09-01T10:00:00.000Z</date></commit></entry>
    <entry line-number="2"><commit revision="15"><author>bob</author><date>2026-09-02T11:00:00.000Z</date></commit></entry>
  </target>
</blame>`);

    assert.deepStrictEqual(lines, [
      {
        line: 1,
        revision: "12",
        author: "alice",
        date: "2026-09-01T10:00:00.000Z"
      },
      {
        line: 2,
        revision: "15",
        author: "bob",
        date: "2026-09-02T11:00:00.000Z"
      }
    ]);
  });

  test("handles entries without commit metadata", async () => {
    const lines = await parseBlameXml(
      `<blame><target path="x"><entry line-number="1"/></target></blame>`
    );
    assert.deepStrictEqual(lines, [
      { line: 1, revision: "-", author: undefined, date: undefined }
    ]);
  });
});
