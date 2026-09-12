import * as assert from "assert";
import { getSvnRepositoryPathFromMetadata } from "../source_control_manager";

suite("Source control repository discovery", () => {
  test("extracts working-copy roots from SVN metadata paths", () => {
    assert.strictEqual(
      getSvnRepositoryPathFromMetadata(
        "/workspace/project/.svn/wc.db",
        ".svn"
      ),
      "/workspace/project"
    );
    assert.strictEqual(
      getSvnRepositoryPathFromMetadata("/workspace/project/.svn", ".svn"),
      "/workspace/project"
    );
    assert.strictEqual(
      getSvnRepositoryPathFromMetadata(
        "C:\\workspace\\project\\_svn\\entries",
        "_svn"
      ),
      "C:\\workspace\\project"
    );
  });

  test("ignores ordinary files and SVN-like directory names", () => {
    assert.strictEqual(
      getSvnRepositoryPathFromMetadata("/workspace/project/file.ts", ".svn"),
      undefined
    );
    assert.strictEqual(
      getSvnRepositoryPathFromMetadata(
        "/workspace/project/.svn-backup/file",
        ".svn"
      ),
      undefined
    );
  });
});
