import * as assert from "assert";
import { getTargetedStatusLogReason } from "../svnLogReasons";

suite("SVN Targeted Status Log Reason Tests", () => {
  const targetedStatus = ["stat", "--xml", "src/file.ts"];

  test("labels watcher-driven targeted status as fs-change", () => {
    assert.equal(
      getTargetedStatusLogReason(targetedStatus, true, false),
      "fs-change"
    );
  });

  test("labels mutation-driven targeted status as svn-operation", () => {
    assert.equal(
      getTargetedStatusLogReason(targetedStatus, false, false),
      "svn-operation"
    );
  });

  test("does not relabel unrelated status commands", () => {
    assert.equal(
      getTargetedStatusLogReason(["stat", "--xml"], true, false),
      undefined
    );
    assert.equal(
      getTargetedStatusLogReason(
        ["stat", "--xml", "--show-updates"],
        false,
        false
      ),
      undefined
    );
    assert.equal(
      getTargetedStatusLogReason(targetedStatus, false, true),
      undefined
    );
  });
});
