import * as assert from "assert";
import { promises as fs } from "fs";
import * as path from "path";
import {
  commands,
  ConfigurationTarget,
  Disposable,
  SecretStorage,
  Uri,
  workspace
} from "vscode";
import { enableIncrementalStatusRefresh } from "../incrementalStatus";
import { Refresh } from "../commands/refresh";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

suite("Settings on an open working copy", () => {
  const keys = [
    "remoteChanges.checkFrequency",
    "autorefresh",
    "refresh.remoteChanges",
    "sourceControl.hideUnversioned",
    "sourceControl.countUnversioned",
    "sourceControl.ignore",
    "log.length",
    "diff.withHead",
    "sourceControl.changesLeftClick"
  ];
  const saved = new Map<string, unknown>();
  let manager: SourceControlManager;
  let server: Uri;
  let repo: Repository;
  async function set(key: string, value: unknown) {
    await workspace
      .getConfiguration("svn")
      .update(key, value, ConfigurationTarget.Global);
  }
  suiteSetup(async () => {
    await testUtil.activeExtension();
    manager = (await commands.executeCommand(
      "svn.getSourceControlManager"
    )) as SourceControlManager;
    server = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(server));
  });
  setup(async () => {
    for (const key of keys)
      saved.set(
        key,
        workspace.getConfiguration("svn").inspect(key)?.globalValue
      );
    await set("remoteChanges.checkFrequency", 0);
    await set("autorefresh", false);
    await set("sourceControl.hideUnversioned", false);
    await set("sourceControl.ignore", []);
    const checkout = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(server) + "/trunk"
    );
    const base = await manager.svn.open(checkout.fsPath, checkout.fsPath);
    await fs.writeFile(path.join(checkout.fsPath, "visible.txt"), "new\n");
    repo = new Repository(base, {
      get: async () => undefined
    } as unknown as SecretStorage);
    await repo.initialStatusSettled;
  });
  teardown(async () => {
    repo?.dispose();
    for (const key of keys) await set(key, saved.get(key));
    saved.clear();
  });
  suiteTeardown(() => testUtil.destroyAllTempPaths());

  test("manual remote refresh with polling disabled awaits exactly one combined scan", async () => {
    await set("refresh.remoteChanges", true);
    const original = repo.repository.getStatus.bind(repo.repository);
    const scans: boolean[] = [];
    repo.repository.getStatus = async options => {
      scans.push(!!options?.checkRemoteChanges);
      return original(options);
    };
    const refresh = Object.create(Refresh.prototype) as Refresh;
    await refresh.execute(repo);
    assert.deepStrictEqual(scans, [true]);
    assert.strictEqual(repo.operations.isIdle(), true);
    repo.dispose();
    await refresh.execute(repo);
    assert.deepStrictEqual(scans, [true]);
  });

  test("visual changes reuse raw status and never emit an authoritative status event", async () => {
    let scans = 0;
    let events = 0;
    const listener = repo.onDidChangeStatus(() => events++);
    const original = repo.repository.getStatus.bind(repo.repository);
    repo.repository.getStatus = async options => {
      scans++;
      return original(options);
    };
    try {
      assert.strictEqual(repo.unversioned.resourceStates.length, 1);
      await set("sourceControl.hideUnversioned", true);
      assert.strictEqual(repo.unversioned.resourceStates.length, 0);
      assert.ok(
        repo.getStatusSnapshot()?.some(status => status.path === "visible.txt")
      );
      await set("sourceControl.hideUnversioned", false);
      assert.strictEqual(repo.unversioned.resourceStates.length, 1);
      await set("sourceControl.countUnversioned", false);
      assert.strictEqual(repo.sourceControl.count, 0);
      await set("sourceControl.countUnversioned", true);
      assert.strictEqual(repo.sourceControl.count, 1);
      await set("sourceControl.ignore", ["*.txt"]);
      assert.strictEqual(repo.unversioned.resourceStates.length, 0);
      await set("sourceControl.ignore", []);
      assert.strictEqual(repo.unversioned.resourceStates.length, 1);
      assert.strictEqual(scans, 0);
      assert.strictEqual(events, 0);
    } finally {
      listener.dispose();
    }
  });

  test("hidden records survive an unrelated incremental operation", async () => {
    const adapters: Disposable[] = [];
    enableIncrementalStatusRefresh(
      {
        repositories: [repo],
        onDidOpenRepository: () => ({ dispose() {} })
      } as unknown as SourceControlManager,
      adapters
    );
    try {
      await set("sourceControl.hideUnversioned", true);
      const other = path.join(repo.workspaceRoot, "other.txt");
      await fs.writeFile(other, "add me\n");
      await repo.addFiles([other]);
      await set("sourceControl.hideUnversioned", false);
      assert.ok(
        repo.unversioned.resourceStates.some(
          resource =>
            resource.resourceUri.fsPath ===
            path.join(repo.workspaceRoot, "visible.txt")
        )
      );
      await set("sourceControl.changesLeftClick", "open");
      assert.strictEqual(
        repo.changes.resourceStates[0].command.command,
        "svn.openFile"
      );
      await set("sourceControl.changesLeftClick", "open diff");
      await set("diff.withHead", false);
      assert.strictEqual(
        repo.changes.resourceStates[0].command.command,
        "svn.openResourceBase"
      );
      await set("diff.withHead", true);
      assert.strictEqual(
        repo.changes.resourceStates[0].command.command,
        "svn.openResourceHead"
      );
    } finally {
      for (const adapter of adapters) adapter.dispose();
    }
  });

  test("queued polling is invalidated by disabling its schedule or disposing", async () => {
    for (const dispose of [false, true]) {
      let release!: (value: boolean) => void;
      let reached!: () => void;
      const waiting = new Promise<void>(resolve => {
        reached = resolve;
      });
      const idle = repo.whenIdleAndFocused;
      repo.whenIdleAndFocused = () => {
        reached();
        return new Promise(resolve => {
          release = resolve;
        });
      };
      let scans = 0;
      const status = repo.repository.getStatus;
      repo.repository.getStatus = async () => {
        scans++;
        return [];
      };
      try {
        const pending = (repo as any).pollRemoteChanges();
        await waiting;
        if (dispose) repo.dispose();
        else await set("remoteChanges.checkFrequency", 1);
        await set("remoteChanges.checkFrequency", 0);
        release(!dispose);
        await pending;
        assert.strictEqual(scans, 0);
      } finally {
        repo.whenIdleAndFocused = idle;
        repo.repository.getStatus = status;
      }
    }
  });

  test("author filtering is literal and bounded even for wildcard characters", async () => {
    const base = repo.repository;
    const original = base.log;
    await set("log.length", 1);
    const calls: unknown[][] = [];
    base.log = async (...args) => {
      calls.push(args);
      return [
        { author: "other", msg: "a*", revision: "4" },
        { author: "alice", msg: "other", revision: "3" },
        { author: "a*", msg: "exact", revision: "2" },
        { author: "a*", msg: "older", revision: "1" }
      ] as any;
    };
    try {
      const result = await base.logByUser("a*");
      assert.deepStrictEqual(
        result.map(entry => entry.revision),
        ["2"]
      );
      assert.deepStrictEqual(calls, [["HEAD", "0", 1000]]);
    } finally {
      base.log = original;
    }
  });
});
