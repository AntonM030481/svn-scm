import * as assert from "assert";
import { getSvnRepositoryPathFromMetadata } from "../source_control_manager";

suite("Source control repository discovery", () => {
  test("extracts working-copy roots from SVN metadata paths", () => {
    const dotSvnChild = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn/wc.db",
      ".svn"
    );
    const dotSvnDirectory = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn",
      ".svn"
    );
    const aspNetSvnChild = getSvnRepositoryPathFromMetadata(
      "C:\\workspace\\project\\_svn\\entries",
      "_svn"
    );

    assert.strictEqual(dotSvnChild, "/workspace/project");
    assert.strictEqual(dotSvnDirectory, "/workspace/project");
    assert.strictEqual(aspNetSvnChild, "C:\\workspace\\project");
  });

  test("ignores ordinary files and SVN-like directory names", () => {
    const ordinaryFile = getSvnRepositoryPathFromMetadata(
      "/workspace/project/file.ts",
      ".svn"
    );
    const lookalikeDirectory = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn-backup/file",
      ".svn"
    );

    assert.strictEqual(ordinaryFile, undefined);
    assert.strictEqual(lookalikeDirectory, undefined);
  });
});
