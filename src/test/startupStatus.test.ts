import * as assert from "assert";
import { promises as fs } from "fs";
import * as path from "path";
import {
  commands,
  Disposable,
  EventEmitter,
  TextDocument,
  Memento,
  SecretStorage,
  Uri,
  ConfigurationTarget,
  workspace,
  window
} from "vscode";
import { enableIncrementalStatusRefresh } from "../incrementalStatus";
import { PullIncommingChange } from "../commands/pullIncomingChange";
import { Revert } from "../commands/revert";
import { Remove } from "../commands/remove";
import { Commit } from "../commands/commit";
import { Resolve } from "../commands/resolve";
import * as messages from "../messages";
import { DeleteUnversioned } from "../commands/deleteUnversioned";
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
      "-dash.txt",
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
      "-dash.txt",
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

  test("file events publish during initial scan and survive its older result", async () => {
    const f = await fixture();
    const base = await manager.svn.open(f.root, f.root);
    const entered = gate();
    const release = gate();
    const getStatus = base.getStatus.bind(base);
    base.getStatus = async params => {
      const old = await getStatus(params);
      entered.resolve();
      await release.promise;
      return old;
    };
    const repo = f.open(base);
    const events = new EventEmitter<Uri>();
    const deletions = new EventEmitter<Uri>();
    const adapters: Disposable[] = [];
    let publications = 0;
    const listener = repo.onDidChangeStatus(() => publications++);
    try {
      await entered.promise;
      repo.fsWatcher.onDidWorkspaceChange = events.event;
      repo.fsWatcher.onDidWorkspaceDelete = deletions.event;
      enableIncrementalStatusRefresh(
        {
          repositories: [repo],
          onDidOpenRepository: () => ({ dispose() {} })
        } as unknown as SourceControlManager,
        adapters
      );
      await workspace
        .getConfiguration("svn")
        .update("autorefresh", true, ConfigurationTarget.Global);
      const changed = path.join(f.root, "new.txt");
      await fs.appendFile(changed, "during startup\n");
      events.fire(Uri.file(changed));
      await new Promise<void>(resolve => setImmediate(resolve));
      await (repo as any).scanStartupFiles();
      assert.equal(repo.isInitialStatusPending, true);
      assert.equal(repo.getResourceFromFile(changed)!.type, Status.MODIFIED);
      assert.ok(repo.isPreviewResource(repo.getResourceFromFile(changed)!));
      assert.equal(publications, 0);
      // A clean verbose result must also survive the old full scan's modified row.
      const reverted = path.join(f.root, "clean.txt");
      await base.exec(["revert", reverted]);
      repo.validateStartupFile(reverted);
      await (repo as any).scanStartupFiles();
      assert.equal(repo.getResourceFromFile(reverted), undefined);
      // Delete events target their parent in normal status, but must invalidate
      // the exact file's startup evidence so it cannot be resurrected by overlay.
      const transient = path.join(f.root, "transient.txt");
      await fs.writeFile(transient, "temporary");
      events.fire(Uri.file(transient));
      await new Promise<void>(resolve => setImmediate(resolve));
      await (repo as any).scanStartupFiles();
      assert.equal(
        repo.getResourceFromFile(transient)!.type,
        Status.UNVERSIONED
      );
      await fs.unlink(transient);
      deletions.fire(Uri.file(transient));
      await new Promise<void>(resolve => setImmediate(resolve));
      await (repo as any).scanStartupFiles();
      release.resolve();
      await repo.initialStatusSettled;
      assert.equal(repo.getResourceFromFile(changed)!.type, Status.MODIFIED);
      assert.equal(repo.getResourceFromFile(reverted), undefined);
      assert.equal(publications, 1);
      assert.equal(repo.getResourceFromFile(transient), undefined);
      const snapshot = f.data.get([...f.data.keys()][0]) as any;
      assert.equal(
        snapshot.statuses.find((s: any) => s.path === "new.txt").status,
        Status.MODIFIED
      );
    } finally {
      release.resolve();
      listener.dispose();
      adapters.forEach(d => d.dispose());
      events.dispose();
      deletions.dispose();
      repo.dispose();
      await workspace
        .getConfiguration("svn")
        .update("autorefresh", false, ConfigurationTarget.Global);
    }
  });

  test("a repeated edit invalidates in-flight startup validation", async () => {
    const f = await fixture();
    const base = await manager.svn.open(f.root, f.root);
    const fullEntered = gate();
    const fullRelease = gate();
    const getStatus = base.getStatus.bind(base);
    base.getStatus = async params => {
      const old = await getStatus(params);
      fullEntered.resolve();
      await fullRelease.promise;
      return old;
    };
    const repo = f.open(base);
    const localEntered = gate();
    const localRelease = gate();
    let pending: Promise<void> | undefined;
    try {
      await fullEntered.promise;
      const file = path.join(f.root, "new.txt");
      const local = base.getStartupStatus.bind(base);
      base.getStartupStatus = async (targets, signal) => {
        const old = await local(targets, signal);
        localEntered.resolve();
        await localRelease.promise;
        return old;
      };
      await fs.appendFile(file, "transient edit\n");
      repo.validateStartupFile(file);
      pending = (repo as any).scanStartupFiles();
      await localEntered.promise;
      await base.exec(["revert", file]);
      repo.validateStartupFile(file);
      localRelease.resolve();
      await pending;
      assert.equal(
        repo.getResourceFromFile(file),
        undefined,
        "obsolete modified result must not publish"
      );
      await (repo as any).scanStartupFiles();
      assert.equal(repo.getResourceFromFile(file), undefined);
      fullRelease.resolve();
      await repo.initialStatusSettled;
      assert.equal(repo.getResourceFromFile(file), undefined);
    } finally {
      localRelease.resolve();
      fullRelease.resolve();
      await pending;
    }
  });

  for (const disposeDuringCheck of [false, true]) {
    test(`startup file validation handles failure/disposal (dispose=${disposeDuringCheck})`, async () => {
      const f = await fixture();
      const before = JSON.stringify([...f.data]);
      const base = await manager.svn.open(f.root, f.root);
      const fullEntered = gate();
      const fullRelease = gate();
      const getStatus = base.getStatus.bind(base);
      base.getStatus = async params => {
        fullEntered.resolve();
        await fullRelease.promise;
        return getStatus(params);
      };
      const repo = f.open(base);
      const localEntered = gate();
      const localRelease = gate();
      let pending: Promise<void> | undefined;
      try {
        await fullEntered.promise;
        base.getStartupStatus = async (_targets, signal) => {
          localEntered.resolve();
          await localRelease.promise;
          if (disposeDuringCheck) assert.equal(signal!.aborted, true);
          throw new Error("injected local failure");
        };
        const file = path.join(f.root, "new.txt");
        await fs.appendFile(file, "new work\n");
        repo.validateStartupFile(file);
        pending = (repo as any).scanStartupFiles();
        await localEntered.promise;
        if (disposeDuringCheck) repo.dispose();
        localRelease.resolve();
        await pending;
        assert.equal(JSON.stringify([...f.data]), before);
        fullRelease.resolve();
        await repo.initialStatusSettled;
        if (!disposeDuringCheck)
          assert.equal(repo.getResourceFromFile(file)!.type, Status.MODIFIED);
        else assert.equal(JSON.stringify([...f.data]), before);
      } finally {
        localRelease.resolve();
        fullRelease.resolve();
        await pending;
      }
    });
  }

  test("retains remote-only and overlapping changes across local refreshes and reopening", async () => {
    const f = await fixture();
    const other = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(server) + "/trunk"
    );
    const remote = await manager.svn.open(other.fsPath, other.fsPath);
    for (const file of ["new.txt", "clean.txt"]) {
      await fs.appendFile(path.join(other.fsPath, file), "remote edit\n");
    }
    await remote.exec(["commit", "-m", "remote startup evidence"]);
    const base = await manager.svn.open(f.root, f.root);
    const repo = f.open(base);
    await repo.initialStatusSettled;
    const adapters: Disposable[] = [];
    enableIncrementalStatusRefresh(
      {
        repositories: [repo],
        onDidOpenRepository: () => ({ dispose() {} })
      } as unknown as SourceControlManager,
      adapters
    );
    const savedRemote = () => {
      const snapshot = f.data.get([...f.data.keys()][0]) as any;
      return snapshot.statuses
        .filter((s: any) => s.reposStatus)
        .map((s: any) => s.path)
        .sort();
    };
    const expected = ["clean.txt", "new.txt"];
    try {
      await repo.updateModelState(true);
      assert.deepEqual(savedRemote(), expected);
      await repo.status();
      assert.deepEqual(savedRemote(), expected);
      await repo.addChangelist([path.join(f.root, "clean.txt")], "remote-kept");
      assert.deepEqual(savedRemote(), expected);
    } finally {
      adapters.forEach(d => d.dispose());
      repo.dispose();
    }
    await workspace
      .getConfiguration("svn")
      .update("remoteChanges.checkFrequency", 300, ConfigurationTarget.Global);
    const entered = gate();
    const release = gate();
    const reopenedBase = await manager.svn.open(f.root, f.root);
    const getStatus = reopenedBase.getStatus.bind(reopenedBase);
    reopenedBase.getStatus = async params => {
      entered.resolve();
      await release.promise;
      return getStatus(params);
    };
    const reopened = f.open(reopenedBase);
    try {
      await entered.promise;
      assert.deepEqual(
        reopened
          .remoteChanges!.resourceStates.map(r =>
            path.basename(r.resourceUri.fsPath)
          )
          .sort(),
        expected
      );
      release.resolve();
      await reopened.initialStatusSettled;
      // A successful remote scan, unlike a local scan, may clear old evidence.
      await reopenedBase.exec(["revert", "-R", "."]);
      await reopenedBase.exec(["update"]);
      await reopened.updateModelState(true);
      assert.deepEqual(savedRemote(), []);
    } finally {
      release.resolve();
      reopened.dispose();
      await workspace
        .getConfiguration("svn")
        .update("remoteChanges.checkFrequency", 0, ConfigurationTarget.Global);
    }
  });

  for (const remoteExists of [false, true]) {
    test(`incoming update revalidates restored remote selections (remote exists=${remoteExists})`, async () => {
      const f = await fixture();
      if (remoteExists) {
        const other = await testUtil.createRepoCheckout(
          testUtil.getSvnUrl(server) + "/trunk"
        );
        const remote = await manager.svn.open(other.fsPath, other.fsPath);
        await fs.appendFile(
          path.join(other.fsPath, "new.txt"),
          "remote edit\n"
        );
        await remote.exec(["commit", "-m", "incoming validation"]);
      }
      const snapshot = f.data.get([...f.data.keys()][0]) as any;
      snapshot.statuses.push({
        path: "new.txt",
        status: Status.NORMAL,
        props: Status.NONE,
        wcStatus: { locked: false, switched: false },
        reposStatus: { item: Status.DELETED, props: Status.NONE }
      });
      await workspace
        .getConfiguration("svn")
        .update(
          "remoteChanges.checkFrequency",
          300,
          ConfigurationTarget.Global
        );
      const base = await manager.svn.open(f.root, f.root);
      const entered = gate();
      const release = gate();
      const getStatus = base.getStatus.bind(base);
      base.getStatus = async params => {
        entered.resolve();
        await release.promise;
        return getStatus(params);
      };
      let updates = 0;
      const pull = base.pullIncomingChange.bind(base);
      base.pullIncomingChange = async file => {
        updates++;
        return pull(file);
      };
      const repo = f.open(base);
      let pending: Promise<unknown> | undefined;
      try {
        await entered.promise;
        const selection = repo.remoteChanges!.resourceStates[0];
        assert.ok(repo.isPreviewResource(selection));
        const command = Object.create(
          PullIncommingChange.prototype
        ) as PullIncommingChange;
        (command as any).runByRepository = async (uris: Uri[], action: any) => [
          await action(repo, uris)
        ];
        pending = command.execute(selection);
        await Promise.resolve();
        assert.equal(updates, 0);
        release.resolve();
        await pending;
        assert.equal(updates, 0, "obsolete remote selection must not update");
        assert.equal(
          await fs.readFile(path.join(f.root, "new.txt"), "utf8"),
          "base\n"
        );
        if (remoteExists) {
          const fresh = repo.remoteChanges!.resourceStates[0];
          await command.execute(fresh);
          assert.equal(updates, 1);
          assert.equal(
            await fs.readFile(path.join(f.root, "new.txt"), "utf8"),
            "base\nremote edit\n"
          );
        }
      } finally {
        release.resolve();
        await pending;
        repo.dispose();
        await workspace
          .getConfiguration("svn")
          .update(
            "remoteChanges.checkFrequency",
            0,
            ConfigurationTarget.Global
          );
      }
    });
  }

  test("restores before scanning, rechecks small files locally and reconciles external edits", async () => {
    const f = await fixture();
    const cached = f.data.get([...f.data.keys()][0]) as any;
    cached.statuses.find((s: any) => s.path === "clean.txt").status =
      Status.CONFLICTED;
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
    base.getStartupStatus = async (files, signal) => {
      targets = files;
      targetedEntered.resolve();
      await allowTargeted.promise;
      return originalTargeted(files, signal);
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
      repo.onDidSaveTextDocument({
        uri: Uri.file(path.join(f.root, "clean.txt")),
        getText: () => {
          assert.fail("saved conflict must not trigger automatic resolution");
        }
      } as unknown as TextDocument);
      assert.equal(repo.isInitialStatusPending, true);
      assert.equal(fullCalls, 0);
      assert.ok(targets.includes("name@peg.txt"));
      assert.ok(targets.includes("-dash.txt"));
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

  test("cleanup recovers after failed startup and fallback status validation", async () => {
    const f = await fixture();
    const base = await manager.svn.open(f.root, f.root);
    const entered = gate();
    const release = gate();
    let recovered = false;
    let scans = 0;
    let cleanups = 0;
    let removals = 0;
    const unversioned = path.join(f.root, "keep-unversioned.txt");
    await fs.writeFile(unversioned, "keep until validated");
    const removeUnversioned = base.removeUnversioned.bind(base);
    base.removeUnversioned = async () => {
      removals++;
      return removeUnversioned();
    };
    const getStatus = base.getStatus.bind(base);
    base.getStatus = async params => {
      scans++;
      entered.resolve();
      await release.promise;
      if (!recovered) throw new Error("status requires cleanup");
      return getStatus(params);
    };
    const cleanup = base.cleanup.bind(base);
    base.cleanup = async () => {
      cleanups++;
      const result = await cleanup();
      recovered = true;
      return result;
    };
    const repo = f.open(base);
    try {
      await entered.promise;
      release.resolve();
      await repo.initialStatusSettled;
      await assert.rejects(repo.removeUnversioned(), /status requires cleanup/);
      assert.equal(removals, 0, "destructive cleanup must require live status");
      assert.equal(
        await fs.readFile(unversioned, "utf8"),
        "keep until validated"
      );
      assert.equal(scans, 2);
      await repo.cleanup();
      assert.equal(cleanups, 1);
      assert.equal(
        scans,
        3,
        "cleanup must execute before another status attempt"
      );
      await repo.ensureStatus();
      assert.equal(scans, 3, "post-cleanup status must establish readiness");
      assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
      await repo.removeUnversioned();
      assert.equal(
        removals,
        1,
        "validated destructive cleanup remains available"
      );
      await assert.rejects(fs.stat(unversioned), /ENOENT/);
    } finally {
      release.resolve();
    }
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
  test("failed full refresh retains the snapshot and a mutation retries authoritative status", async () => {
    const f = await fixture();
    const before = JSON.stringify([...f.data]);
    const base = await manager.svn.open(f.root, f.root);
    const getStatus = base.getStatus.bind(base);
    let fail = true;
    base.getStatus = async params => {
      if (fail) throw new Error("full scan failed");
      return getStatus(params);
    };
    const repo = f.open(base);
    await repo.initialStatusSettled;
    assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
    assert.equal(JSON.stringify([...f.data]), before);
    await assert.rejects(repo.ensureStatus(), /full scan failed/);
    fail = false;
    await repo.ensureStatus();
    assert.ok(repo.getResourceFromFile(path.join(f.root, "clean.txt")));
  });

  test("mutations wait for the initial full scan", async () => {
    const f = await fixture();
    const base = await manager.svn.open(f.root, f.root);
    const entered = gate();
    const release = gate();
    const getStatus = base.getStatus.bind(base);
    base.getStatus = async params => {
      entered.resolve();
      await release.promise;
      return getStatus(params);
    };
    let mutations = 0;
    const addChangelist = base.addChangelist.bind(base);
    base.addChangelist = async (files, name) => {
      mutations++;
      return addChangelist(files, name);
    };
    const repo = f.open(base);
    const adapters: Disposable[] = [];
    enableIncrementalStatusRefresh(
      {
        repositories: [repo],
        onDidOpenRepository: () => ({ dispose() {} })
      } as unknown as SourceControlManager,
      adapters
    );
    try {
      await entered.promise;
      const mutation = repo.addChangelist(
        [path.join(f.root, "clean.txt")],
        "after-startup"
      );
      await Promise.resolve();
      assert.equal(mutations, 0);
      release.resolve();
      await mutation;
      assert.equal(mutations, 1);
      assert.equal(
        repo.changelists.get("after-startup")!.resourceStates.length,
        1
      );
    } finally {
      release.resolve();
      await repo.initialStatusSettled;
      adapters.forEach(adapter => adapter.dispose());
    }
  });

  test("delete-unversioned revalidates a cached selection before deleting", async () => {
    const f = await fixture();
    const file = path.join(f.root, "unversioned.txt");
    await fs.writeFile(file, "keep me");
    const first = f.open(await manager.svn.open(f.root, f.root));
    await first.initialStatusSettled;
    const selection = first.getResourceFromFile(file)!;
    assert.equal(selection.type, Status.UNVERSIONED);
    first.dispose();
    await f.base.exec(["add", "unversioned.txt"]);
    const repo = f.open(await manager.svn.open(f.root, f.root));
    const command = Object.create(
      DeleteUnversioned.prototype
    ) as DeleteUnversioned;
    (command as any).runByRepository = async (uris: Uri[], action: any) => [
      await action(repo, uris)
    ];
    await command.execute(selection);
    assert.equal(await fs.readFile(file, "utf8"), "keep me");
    assert.equal(repo.getResourceFromFile(file)!.type, Status.ADDED);
  });
  for (const keepDirectoryProperty of [false, true]) {
    test(`SCM mutations reject restored directories before prompting (property retained=${keepDirectoryProperty})`, async () => {
      const f = await fixture();
      const directory = path.join(f.root, "directory");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "child.txt"), "base");
      await f.base.exec(["add", "--force", "directory"]);
      await f.base.exec(["commit", "directory", "-m", "directory fixture"]);
      await f.base.exec(["propset", "test:property", "yes", "directory"]);
      const first = f.open(await manager.svn.open(f.root, f.root));
      await first.initialStatusSettled;
      let selection = first.getResourceFromFile(directory)!;
      assert.ok(selection);
      first.dispose();
      if (!keepDirectoryProperty)
        await f.base.exec(["revert", "--depth", "empty", "directory"]);
      await fs.writeFile(
        path.join(directory, "child.txt"),
        "new unseen changes"
      );
      const base = await manager.svn.open(f.root, f.root);
      const entered = gate();
      const release = gate();
      const getStatus = base.getStatus.bind(base);
      base.getStatus = async params => {
        entered.resolve();
        await release.promise;
        return getStatus(params);
      };
      const repo = f.open(base);
      const warning = window.showWarningMessage;
      const quickPick = window.showQuickPick;
      const commitMessage = messages.inputCommitMessage;
      let prompts = 0;
      const unexpectedPrompt = async () => {
        prompts++;
        return undefined;
      };
      (window as any).showWarningMessage = unexpectedPrompt;
      (window as any).showQuickPick = unexpectedPrompt;
      (messages as any).inputCommitMessage = unexpectedPrompt;
      const pending: Promise<unknown>[] = [];
      try {
        await entered.promise;
        selection = repo.getResourceFromFile(directory)!;
        assert.ok(repo.isPreviewResource(selection));
        for (const ctor of [Revert, Remove, Commit, Resolve]) {
          const command = Object.create(ctor.prototype);
          command.runByRepository = async (uris: Uri[], action: any) => [
            await action(repo, uris)
          ];
          pending.push(command.execute(selection));
        }
        await Promise.resolve();
        assert.equal(prompts, 0);
        release.resolve();
        await Promise.all(pending);
        assert.equal(
          prompts,
          0,
          "removed cached entry must not be confirmed or mutated"
        );
        if (keepDirectoryProperty) {
          const fresh = repo.getResourceFromFile(directory)!;
          assert.ok(fresh);
          assert.equal(repo.isPreviewResource(fresh), false);
          const command = Object.create(Revert.prototype);
          command.runByRepository = async (uris: Uri[], action: any) => [
            await action(repo, uris)
          ];
          assert.equal(
            (await command.getResourceStates([fresh], true)).length,
            1
          );
        } else {
          assert.equal(repo.getResourceFromFile(directory), undefined);
        }
        assert.equal(
          await fs.readFile(path.join(directory, "child.txt"), "utf8"),
          "new unseen changes"
        );
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        (window as any).showWarningMessage = warning;
        (window as any).showQuickPick = quickPick;
        (messages as any).inputCommitMessage = commitMessage;
      }
    });
  }
});
