import * as assert from "assert";
import { Uri } from "vscode";
import { openMergeEditor } from "../mergeEditor";
import { getTextConflictInputs, parseInfoXml } from "../parser/infoParser";

suite("Conflict merge editor", () => {
  test("parses text conflict inputs from SVN info XML", async () => {
    const info = await parseInfoXml(`<?xml version="1.0"?>
<info><entry kind="file" path="file.txt" revision="2">
<url>https://example.test/file.txt</url><relative-url>^/file.txt</relative-url>
<repository><root>https://example.test</root><uuid>uuid</uuid></repository>
<commit revision="2"><author>author</author><date>date</date></commit>
<conflict operation="update" type="text">
<prev-base-file>C:/wc/file.txt.r1</prev-base-file>
<prev-wc-file>C:/wc/file.txt.mine</prev-wc-file>
<cur-base-file>C:/wc/file.txt.r2</cur-base-file>
</conflict></entry></info>`);

    assert.deepStrictEqual(getTextConflictInputs(info), {
      base: "C:/wc/file.txt.r1",
      current: "C:/wc/file.txt.mine",
      incoming: "C:/wc/file.txt.r2"
    });
  });

  test("ignores non-text and incomplete conflict metadata", () => {
    const base = {
      kind: "file",
      path: "file.txt",
      revision: "2",
      url: "url",
      relativeUrl: "^/file.txt",
      repository: { root: "root", uuid: "uuid" },
      commit: { revision: "2", author: "author", date: "date" }
    };

    assert.strictEqual(
      getTextConflictInputs({ ...base, conflict: { type: "tree" } }),
      undefined
    );
    assert.strictEqual(
      getTextConflictInputs({
        ...base,
        conflict: { type: "text", prevBaseFile: "base" }
      }),
      undefined
    );
  });

  test("opens the merge editor with SVN sides in stable roles", async () => {
    const calls: Array<{ command: string; argument: any }> = [];
    const output = Uri.file("C:/wc/file.txt");
    const opened = await openMergeEditor(
      {
        base: "C:/wc/file.txt.r1",
        current: "C:/wc/file.txt.mine",
        incoming: "C:/wc/file.txt.r2"
      },
      output,
      {
        getCommands: async () => ["_open.mergeEditor"],
        executeCommand: async (command, argument) => {
          calls.push({ command, argument });
          return undefined;
        }
      }
    );

    assert.strictEqual(opened, true);
    assert.strictEqual(calls[0].command, "_open.mergeEditor");
    assert.strictEqual(calls[0].argument.base.fsPath, "c:\\wc\\file.txt.r1");
    assert.strictEqual(calls[0].argument.input1.title, "Incoming");
    assert.strictEqual(calls[0].argument.input2.title, "Current");
    assert.strictEqual(calls[0].argument.output, output);
  });

  test("reports unavailable merge editor without invoking it", async () => {
    let invoked = false;
    const opened = await openMergeEditor(
      { base: "base", current: "current", incoming: "incoming" },
      Uri.file("output"),
      {
        getCommands: async () => [],
        executeCommand: async () => {
          invoked = true;
          return undefined;
        }
      }
    );

    assert.strictEqual(opened, false);
    assert.strictEqual(invoked, false);
  });
});
