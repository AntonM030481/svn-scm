import * as assert from "assert";
import {
  boundedInteger,
  logLimit,
  matchLayout,
  remoteIntervalSeconds
} from "../helpers/settingValues";

suite("Setting runtime validation", () => {
  test("unsafe timer values cannot become rapid polling", () => {
    for (const value of [
      -1,
      0.1,
      NaN,
      Infinity,
      "300",
      null,
      undefined,
      2147484
    ]) {
      assert.strictEqual(remoteIntervalSeconds(value), 0);
    }
    assert.strictEqual(remoteIntervalSeconds(0), 0);
    assert.strictEqual(remoteIntervalSeconds(2147483), 2147483);
    assert.strictEqual(remoteIntervalSeconds(300), 300);
  });
  test("log and discovery bounds use safe defaults", () => {
    for (const value of [0, -1, 1.5, "50", NaN, Infinity, 1001])
      assert.strictEqual(logLimit(value), 50);
    assert.strictEqual(logLimit(1000), 1000);
    assert.strictEqual(logLimit(1), 1);
    assert.strictEqual(boundedInteger(-1, 4, 0, 100), 4);
    assert.strictEqual(boundedInteger(0, 4, 0, 100), 0);
  });
  test("disabled, malformed and invalid-capture layouts cannot throw", () => {
    for (const regex of [null, undefined, "[", "(", 3, ""])
      assert.strictEqual(matchLayout("tags/a/b", regex, 1), undefined);
    for (const group of [0, -1, 1.5, "1", NaN, 101, 3])
      assert.strictEqual(
        matchLayout("tags/a/b", "tags/([^/]+)/([^/]+)", group),
        undefined
      );
    assert.deepStrictEqual(
      matchLayout("https://host/tags/a/b", "tags/([^/]+)/([^/]+)", 2),
      { name: "b", path: "tags/a/b" }
    );
  });
});
