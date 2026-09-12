import * as assert from "assert";
import { SvnFileSystemProvider } from "../svnFileSystemProvider";

suite("SVN FileSystemProvider Lifecycle", () => {
  test("dispose clears the cleanup interval once", () => {
    const provider = Object.create(
      SvnFileSystemProvider.prototype
    ) as SvnFileSystemProvider;
    const state = provider as any;
    const intervalHandle = {} as ReturnType<typeof setInterval>;

    state.disposed = false;
    state.disposables = [];
    state.cleanupInterval = intervalHandle;

    const originalClearInterval = global.clearInterval;
    const cleared: unknown[] = [];
    (global as any).clearInterval = (handle: unknown) => cleared.push(handle);

    try {
      provider.dispose();
      provider.dispose();

      assert.equal(state.disposed, true);
      assert.equal(state.cleanupInterval, undefined);
      assert.deepEqual(cleared, [intervalHandle]);
    } finally {
      (global as any).clearInterval = originalClearInterval;
    }
  });
});
