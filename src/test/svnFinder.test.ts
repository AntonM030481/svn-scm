import * as assert from "assert";
import { SvnFinder } from "../svnFinder";

suite("SVN version capability contract", () => {
  test("publishes normalized versions without modifying discovery input", async () => {
    const input = {
      path: "vendor/svn",
      version: "1.6.17-SlikSvn-tag-1.6.17@1130898-X64"
    };
    const result = await new SvnFinder().checkSvnVersion(input);
    assert.deepStrictEqual(result, { path: input.path, version: "1.6.17" });
    assert.notStrictEqual(input.version, result.version);
  });

  for (const version of ["garbage", "1.5.9-vendor"]) {
    test(`rejects unsupported version ${version}`, async () => {
      await assert.rejects(
        new SvnFinder().checkSvnVersion({ path: "svn", version })
      );
    });
  }
});
