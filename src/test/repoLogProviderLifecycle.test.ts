import * as assert from "assert";
import { RepoLogProvider } from "../historyView/repoLogProvider";

suite("Repository history lifecycle", () => {
  test("dispose releases transient UI, cache, events and registrations once", () => {
    const provider = Object.create(
      RepoLogProvider.prototype
    ) as RepoLogProvider;
    const state = provider as any;
    const disposed: string[] = [];

    state.disposed = false;
    state.inputBoxes = new Set([
      { dispose: () => disposed.push("input-one") },
      { dispose: () => disposed.push("input-two") }
    ]);
    state._dispose = [{ dispose: () => disposed.push("registration") }];
    state.logCache = new Map([["repository", {}]]);
    state._onDidChangeTreeData = {
      dispose: () => disposed.push("event")
    };

    provider.dispose();
    provider.dispose();

    assert.deepStrictEqual(disposed, [
      "input-one",
      "input-two",
      "registration",
      "event"
    ]);
    assert.equal(state.disposed, true);
    assert.equal(state.inputBoxes.size, 0);
    assert.equal(state.logCache.size, 0);
  });
});
