import * as assert from "assert";
import { parseSvnPropertyValue } from "../parser/propertyParser";

suite("SVN property parser", () => {
  test("preserves whitespace and decodes entities in property values", async () => {
    const value = await parseSvnPropertyValue(
      '<?xml version="1.0"?><properties><target path="."><property name="svn:ignore">  spaced pattern  \na&amp;b</property></target></properties>'
    );

    assert.strictEqual(value, "  spaced pattern  \na&b");
  });

  test("returns an empty value for an empty property", async () => {
    const value = await parseSvnPropertyValue(
      '<?xml version="1.0"?><properties><target path="."><property name="svn:ignore"/></target></properties>'
    );

    assert.strictEqual(value, "");
  });

  test("decodes property values emitted as base64", async () => {
    const encoded = Buffer.from("*.tmp\nspaced pattern", "utf8").toString(
      "base64"
    );
    const value = await parseSvnPropertyValue(
      `<properties><target path="."><property name="svn:ignore" encoding="base64">${encoded}</property></target></properties>`
    );

    assert.strictEqual(value, "*.tmp\nspaced pattern");
  });

  test("rejects unsupported property encodings", async () => {
    await assert.rejects(
      parseSvnPropertyValue(
        '<properties><target path="."><property name="svn:ignore" encoding="other">value</property></target></properties>'
      ),
      /Unsupported SVN property encoding: other/
    );
  });
});
