import * as assert from "assert";
import { getSvnLogReason } from "../svn";

suite("SVN Logging Tests", () => {
  test("uses explicit repository detection reason", () => {
    assert.equal(
      getSvnLogReason(["info", "--xml"], "repository-detect"),
      "repository-detect"
    );
  });

  test("classifies repository and path info", () => {
    assert.equal(getSvnLogReason(["info", "--xml"]), "repository-info");
    assert.equal(
      getSvnLogReason(["info", "--xml", "src/file.ts"]),
      "path-info"
    );
  });

  test("classifies status operations", () => {
    assert.equal(
      getSvnLogReason(["stat", "--xml", "--show-updates"]),
      "remote-status"
    );
    assert.equal(getSvnLogReason(["stat", "--xml"]), "status");
    assert.equal(
      getSvnLogReason(["stat", "--xml", "src/file.ts"]),
      "targeted-status"
    );
  });

  test("classifies quick diff and direct svn operations", () => {
    assert.equal(getSvnLogReason(["cat", "src/file.ts"]), "quick-diff");
    assert.equal(getSvnLogReason(["update"]), "update");
    assert.equal(getSvnLogReason(["commit", "src/file.ts"]), "commit");
  });
});
