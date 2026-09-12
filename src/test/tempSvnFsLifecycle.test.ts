import * as assert from "assert";
import { Uri } from "vscode";
import { TempSvnFs } from "../temp_svn_fs";

suite("Temp SVN FS Lifecycle", () => {
  test("dispose cancels buffered file change events", async () => {
    const provider = new TempSvnFs();
    let eventCount = 0;
    const listener = provider.onDidChangeFile(() => {
      eventCount += 1;
    });

    try {
      provider.createDirectory(Uri.parse("tempsvnfs:/pending"));
      provider.dispose();

      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(eventCount, 0);
      assert.equal((provider as any)._fireSoonHandler, undefined);
      assert.deepEqual((provider as any)._bufferedEvents, []);
    } finally {
      listener.dispose();
      provider.dispose();
    }
  });
});
