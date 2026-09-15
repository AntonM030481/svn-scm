import * as assert from "assert";
import { Uri, window } from "vscode";
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
      "input-two",
      "input-one",
      "registration",
      "event"
    ]);
    assert.equal(state.disposed, true);
    assert.equal(state.inputBoxes.size, 0);
    assert.equal(state.logCache.size, 0);
  });

  for (const remote of [false, true]) {
    test(`dispose suppresses a late ${remote ? "remote" : "local"} resolution failure`, async () => {
      const provider = Object.create(
        RepoLogProvider.prototype
      ) as RepoLogProvider;
      const state = provider as any;
      let rejectResolution!: (error: Error) => void;
      const resolution = new Promise<never>((_resolve, reject) => {
        rejectResolution = reject;
      });
      const repository = { getInfo: () => resolution };
      const sourceControlManager = {
        getRepository: () => (remote ? null : repository),
        getRemoteRepository: () => resolution
      };
      const originalWarning = window.showWarningMessage;
      const originalError = window.showErrorMessage;
      let notifications = 0;

      state.disposed = false;
      state.inputBoxes = new Set();
      state._dispose = [];
      state.logCache = new Map();
      state._onDidChangeTreeData = { dispose() {}, fire() {} };
      state.sourceControlManager = sourceControlManager;
      (window as any).showWarningMessage = async () => notifications++;
      (window as any).showErrorMessage = async () => notifications++;

      try {
        const pending = state.addRepolike(
          remote ? "https://example.test/svn/trunk" : "/working-copy",
          "HEAD"
        );
        provider.dispose();
        rejectResolution(new Error("late failure"));
        await pending;

        assert.equal(notifications, 0);
      } finally {
        window.showWarningMessage = originalWarning;
        window.showErrorMessage = originalError;
        provider.dispose();
      }
    });
  }

  test("dispose prevents caret resolution from opening a remote repository", async () => {
    const provider = Object.create(
      RepoLogProvider.prototype
    ) as RepoLogProvider;
    const state = provider as any;
    let resolveInfo!: (info: { url: string }) => void;
    const info = new Promise<{ url: string }>(resolve => {
      resolveInfo = resolve;
    });
    let repositoryLookups = 0;
    let remoteOpens = 0;

    state.disposed = false;
    state.inputBoxes = new Set();
    state._dispose = [];
    state.logCache = new Map();
    state._onDidChangeTreeData = { dispose() {}, fire() {} };
    state.sourceControlManager = {
      getRepository: () => {
        repositoryLookups++;
        return repositoryLookups === 1 ? null : { getInfo: () => info };
      },
      getRemoteRepository: () => {
        remoteOpens++;
        return Promise.reject(new Error("unexpected remote open"));
      }
    };

    const pending = state.addRepolike("^/trunk", "HEAD");
    await Promise.resolve();
    provider.dispose();
    resolveInfo({ url: "https://example.test/svn/trunk" });
    await pending;

    assert.equal(remoteOpens, 0);
  });

  test("dispose continues after a transient UI cleanup throws", () => {
    const provider = Object.create(
      RepoLogProvider.prototype
    ) as RepoLogProvider;
    const state = provider as any;
    const disposed: string[] = [];
    const originalError = console.error;

    state.disposed = false;
    state.inputBoxes = new Set([
      {
        dispose: () => {
          throw new Error("input cleanup failed");
        }
      },
      { dispose: () => disposed.push("remaining-input") }
    ]);
    state._dispose = [{ dispose: () => disposed.push("registration") }];
    state.logCache = new Map([["repository", {}]]);
    state._onDidChangeTreeData = {
      dispose: () => disposed.push("event")
    };
    console.error = () => undefined;

    try {
      provider.dispose();
    } finally {
      console.error = originalError;
    }

    assert.deepStrictEqual(disposed, [
      "remaining-input",
      "registration",
      "event"
    ]);
    assert.equal(state.logCache.size, 0);
  });

  test("repository changes invalidate only the matching history cache", () => {
    const provider = Object.create(
      RepoLogProvider.prototype
    ) as RepoLogProvider;
    const state = provider as any;
    const changedRepository = {
      branchRoot: Uri.parse("https://example.test/svn/changed"),
      repository: { info: { revision: "42" } }
    };
    const unrelatedRepository = {
      branchRoot: Uri.parse("https://example.test/svn/unrelated"),
      repository: { info: { revision: "7" } }
    };
    const persisted = { commitFrom: "100", baseRevision: 42 };
    const changed = {
      entries: [{ revision: "100" }],
      isComplete: true,
      repo: changedRepository,
      svnTarget: changedRepository.branchRoot,
      persisted,
      order: 3
    };
    const unrelated = {
      entries: [{ revision: "7" }],
      isComplete: true,
      repo: unrelatedRepository,
      svnTarget: unrelatedRepository.branchRoot,
      persisted: { commitFrom: "HEAD", baseRevision: 7 },
      order: 4
    };
    let refreshes = 0;
    state.logCache = new Map([
      [changedRepository.branchRoot.toString(true), changed],
      [unrelatedRepository.branchRoot.toString(true), unrelated]
    ]);
    state._onDidChangeTreeData = { fire: () => refreshes++ };

    state.refreshRepository(changedRepository);

    const refreshed = state.logCache.get(
      changedRepository.branchRoot.toString(true)
    );
    assert.notStrictEqual(refreshed, changed);
    assert.deepStrictEqual(refreshed.entries, []);
    assert.strictEqual(refreshed.persisted, persisted);
    assert.equal(refreshed.order, 3);
    assert.strictEqual(
      state.logCache.get(unrelatedRepository.branchRoot.toString(true)),
      unrelated
    );
    assert.equal(refreshes, 1);
  });
});
