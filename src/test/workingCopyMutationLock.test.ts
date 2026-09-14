import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import {
  withWorkingCopyMutationLock,
  withWorkingCopyMutationLocks
} from "../workingCopyMutationLock";

suite("Working-copy mutation lock", () => {
  test("serializes one physical working copy and is reentrant", async () => {
    const root = path.join(os.tmpdir(), "svn-scm-lock-a");
    const events: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => (entered = resolve));
    const blocked = new Promise<void>(resolve => (release = resolve));

    const first = withWorkingCopyMutationLock(root, async () => {
      events.push("first");
      await withWorkingCopyMutationLock(root, async () => {
        events.push("nested");
      });
      entered();
      await blocked;
      events.push("first-done");
    });

    await enteredPromise;
    const second = withWorkingCopyMutationLock(root, async () => {
      events.push("second");
    });
    assert.deepStrictEqual(events, ["first", "nested"]);

    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ["first", "nested", "first-done", "second"]);
  });

  test("orders multi-root acquisition without blocking unrelated roots", async () => {
    const rootA = path.join(os.tmpdir(), "svn-scm-lock-a");
    const rootB = path.join(os.tmpdir(), "svn-scm-lock-b");
    const rootC = path.join(os.tmpdir(), "svn-scm-lock-c");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => (entered = resolve));
    const blocked = new Promise<void>(resolve => (release = resolve));

    const both = withWorkingCopyMutationLocks([rootB, rootA], async () => {
      entered();
      await blocked;
    });
    await enteredPromise;

    let unrelatedRan = false;
    await withWorkingCopyMutationLock(rootC, async () => {
      unrelatedRan = true;
    });
    assert.equal(unrelatedRan, true);

    release();
    await both;
  });
});
