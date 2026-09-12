import * as assert from "assert";
import SvnError, { getErrorMessage } from "../svnError";

suite("SvnError", () => {
  test("is a native Error", () => {
    const error = new SvnError({
      message: "SVN failed",
      svnErrorCode: "E123456"
    });

    assert.ok(error instanceof Error);
    assert.ok(error instanceof SvnError);
    assert.strictEqual(error.name, "SvnError");
    assert.strictEqual(error.message, "SVN failed");
    assert.strictEqual(error.svnErrorCode, "E123456");
  });

  test("prefers formatted stderr for display", () => {
    const error = new SvnError({
      message: "SVN failed",
      stderr: "raw stderr",
      stderrFormated: "formatted stderr"
    });

    assert.strictEqual(error.displayMessage, "formatted stderr");
  });

  test("falls back to stderr and message for display", () => {
    assert.strictEqual(
      new SvnError({ message: "SVN failed", stderr: "raw stderr" })
        .displayMessage,
      "raw stderr"
    );
    assert.strictEqual(
      new SvnError({ message: "SVN failed" }).displayMessage,
      "SVN failed"
    );
  });

  test("extracts messages from unknown errors safely", () => {
    assert.strictEqual(getErrorMessage(new Error("boom")), "boom");
    assert.strictEqual(getErrorMessage("boom"), "boom");
    assert.strictEqual(getErrorMessage(null), "null");
  });
});
