import * as assert from "assert";
import { promises as fs } from "fs";
import * as path from "path";
import {
  commands,
  Memento,
  SecretStorage,
  Uri,
  ConfigurationTarget,
  workspace
} from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { Status } from "../common/types";
import { STARTUP_MAX_FILE_BYTES } from "../statusSnapshot";
import * as testUtil from "./testUtil";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

suite("Persisted startup status integration", () => {
  let manager: SourceControlManager;
  let server: Uri;
  let oldFrequency: number | undefined;
  let oldRefresh: boolean | undefined;
  const owned: Repository[] = [];

  suiteSetup(async () => {
    await testUtil.activeExtension();
    const config = workspace.getConfiguration("svn");
    oldFrequency = config.inspect<number>(
      "remoteChanges.checkFrequency"
    )?.globalValue;
    oldRefresh = config.inspect<boolean>("autorefresh")?.globalValue;
    await config.update(
      "remoteChanges.checkFrequency",
      0,
      ConfigurationTarget.Global
    );
    await config.update("autorefresh", false, ConfigurationTarget.Global);
    server = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(server));
    manager = (await commands.executeCommand(
      "svn.getSourceControlManager"
    )) as SourceControlManager;
  });

  teardown(async () => {
    for (const repo of owned.splice(0)) {
      repo.dispose();
      await repo.initialStatusSettled;
    }
  });

  suiteTeardown(async () => {
    const config = workspace.getConfiguration("svn");
    await config.update(
      "remoteChanges.checkFrequency",
      oldFrequency,
      ConfigurationTarget.Global
    );
    await config.update("autorefresh", oldRefresh, ConfigurationTarget.Global);
    testUtil.destroyAllTempPaths();
  });

  async function fixture() {
    const checkout = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(server) + "/trunk"
    );
    const root = checkout.fsPath;
    const data = new Map<string, unknown>();
    const state: Memento = {
      keys: () => [...data.keys()],
      get: <T>(key: string, fallback?: T) =>
        (data.has(key) ? data.get(key) : fallback) as T,
      update: async (key, value) => {
        data.set(key, JSON.parse(JSON.stringify(value ?? null)));
      }
    };
    const base = await manager.svn.open(root, root);
    for (const file of [
      "clean.txt",
      "props.txt",
      "new.txt",
      "missing.txt",
      "large.bin",
      "name@peg.txt"
    ]) {
      await fs.writeFile(path.join(root, file), "base\n");
    }
    await base.exec(["add", "--force", "."]);
    await base.exec(["commit", "-m", "startup fixture"]);
    for (const file of [
      "clean.txt",
      "missing.txt",
      "large.bin",
      "name@peg.txt"
    ]) {
      await fs.appendFile(path.join(root, file), "changed\n");
    }
    await base.exec(["propset", "test:property", "yes", "props.txt"]);
    await base.exec(["changelist", "work", "props.txt"]);
    const handle = await fs.open(path.join(root, "large.bin"), "r+");
    await handle.truncate(STARTUP_MAX_FILE_BYTES + 1);
    await handle.close();
    const open = (b: typeof base) => {
      const repo = new Repository(
        b,
        { get: async () => undefined } as unknown as SecretStorage,
        state
      );
      owned.push(repo);
      return repo;
    };
    const initial = open(base);
    await initial.initialStatusSettled;
    assert.ok(initial.getResourceFromFile(path.join(root, "clean.txt")));
    assert.equal(data.size, 1);
    initial.dispose();
    return { root, base, data, state, open };
  }

  test("restores before scanning, rechecks small files locally and reconciles external edits", async () => {
    const f = await fixture();
    await f.base.exec(["revert", "clean.txt"]);
    await fs.unlink(path.join(f.root, "missing.txt"));
    await fs.appendFile(path.join(f.root, "new.txt"), "external edit\n");
    const base = await manager.svn.open(f.root, f.root);
    const targetedEntered = gate();
    const allowTargeted = gate();
    const fullEntered = gate();
    const allowFull = gate();
    let targets: string[] = [];
    let fullCalls = 0;
    const originalTargeted = base.getStartupStatus.bind(base);
    base.getStartupStatus = async files => {
      targets = files;
      targetedEntered.resolve();
      await allowTargeted.promise;
      return originalTargeted(files);
    };
    const originalFull = base.getStatus.bind(base);
    base.getStatus = async params => {
      fullCalls++;
      assert.equal(params.checkRemoteChanges, false);
      fullEntered.resolve();
      await allowFull.promise;
      return originalFull(params);
    };
    const repo = f.open(base);
    let events = 0;
    const listener = repo.onDidChangeStatus(() => events++);
    try {
      await targetedEntered.promise;
      assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
      assert.ok(repo.sourceControl.quickDiffProvider);
      assert.equal(repo.isInitialStatusPending, true);
      assert.equal(fullCalls, 0);
      assert.ok(targets.includes("name@peg.txt"));
      assert.ok(!targets.includes("large.bin"));
      assert.ok(!targets.includes("missing.txt"));
      let ready = false;
      const readiness = repo.ensureStatus().then(() => {
        ready = true;
      });
      allowTargeted.resolve();
      await fullEntered.promise;
      assert.equal(
        repo.getResourceFromFile(path.join(f.root, "clean.txt")),
        undefined
      );
      assert.ok(repo.getResourceFromFile(path.join(f.root, "large.bin")));
      assert.equal(
        repo.getResourceFromFile(path.join(f.root, "new.txt")),
        undefined
      );
      assert.equal(
        repo.getResourceFromFile(path.join(f.root, "missing.txt"))!.type,
        Status.MODIFIED
      );
      assert.equal(repo.changelists.get("work")!.resourceStates.length, 1);
      assert.equal(
        events,
        0,
        "preview must not publish authoritative status events"
      );
      assert.equal(ready, false);
      allowFull.resolve();
      await readiness;
      assert.equal(events, 1);
      assert.equal(fullCalls, 1);
      assert.equal(
        repo.getResourceFromFile(path.join(f.root, "missing.txt"))!.type,
        Status.MISSING
      );
      assert.ok(repo.getResourceFromFile(path.join(f.root, "new.txt")));
      assert.equal(repo.isInitialStatusPending, false);
    } finally {
      allowTargeted.resolve();
      allowFull.resolve();
      listener.dispose();
      await repo.initialStatusSettled;
    }
  });

  test("failed fast validation falls back to a full scan", async () => {
    const f = await fixture();
    const base = await manager.svn.open(f.root, f.root);
    let fast = 0;
    let full = 0;
    base.getStartupStatus = async () => {
      fast++;
      throw new Error("target unavailable");
    };
    const getStatus = base.getStatus.bind(base);
    base.getStatus = async p => {
      full++;
      return getStatus(p);
    };
    const repo = f.open(base);
    await repo.initialStatusSettled;
    assert.equal(fast, 1);
    assert.equal(full, 1);
    assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
  });

  test("corrupt snapshot uses normal full startup without targeted work", async () => {
    const f = await fixture();
    f.data.set([...f.data.keys()][0], { version: 1, statuses: null });
    const base = await manager.svn.open(f.root, f.root);
    base.getStartupStatus = async () => {
      assert.fail("unexpected targeted scan");
    };
    const repo = f.open(base);
    await repo.initialStatusSettled;
    assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
  });

  test("disposal during fast validation prevents full scan, publication and persistence", async () => {
    const f = await fixture();
    const before = JSON.stringify([...f.data]);
    const base = await manager.svn.open(f.root, f.root);
    const entered = gate();
    const release = gate();
    base.getStartupStatus = async () => {
      entered.resolve();
      await release.promise;
      return [];
    };
    let full = 0;
    base.getStatus = async () => {
      full++;
      return [];
    };
    const repo = f.open(base);
    let events = 0;
    const listener = repo.onDidChangeStatus(() => events++);
    try {
      await entered.promise;
      repo.dispose();
      release.resolve();
      await repo.initialStatusSettled;
      assert.equal(full, 0);
      assert.equal(events, 0);
      assert.equal(JSON.stringify([...f.data]), before);
    } finally {
      release.resolve();
      listener.dispose();
    }
  });
});
