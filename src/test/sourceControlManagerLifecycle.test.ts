import * as assert from "assert";
import {
  Disposable,
  EventEmitter,
  ExtensionContext,
  Uri,
  workspace
} from "vscode";
import { ConstructorPolicy, RepositoryState } from "../common/types";
import { configuration } from "../helpers/configuration";
import { SourceControlManager } from "../source_control_manager";
import { Svn } from "../svn";

suite("Source control manager lifecycle", () => {
  let manager: SourceControlManager;
  let enabled: boolean;
  let watcherFailure: boolean;
  let activeWatchers: number;
  let activeListeners: number;
  let scans: Array<{ resolve(): void; reject(error: Error): void }>;
  let logs: string[];
  let restore: Array<() => void>;
  const stub = (object: any, key: string, value: unknown) => {
    const original = object[key];
    restore.push(() => {
      object[key] = original;
    });
    object[key] = value;
  };
  const change = (value: boolean) => {
    enabled = value;
    (manager as any).onDidChangeConfiguration();
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));

  setup(() => {
    enabled = true;
    watcherFailure = false;
    activeWatchers = 0;
    activeListeners = 0;
    scans = [];
    logs = [];
    restore = [];
    stub(configuration, "get", (key: string, fallback: unknown) =>
      key === "enabled" ? enabled : fallback
    );
    const listen = (
      _handler: unknown,
      _owner: unknown,
      disposables?: Disposable[]
    ) => {
      activeListeners++;
      const resource = new Disposable(() => {
        activeListeners--;
      });
      disposables?.push(resource);
      return resource;
    };
    stub(workspace, "onDidChangeConfiguration", listen);
    stub(workspace, "onDidChangeWorkspaceFolders", listen);
    stub(workspace, "createFileSystemWatcher", () => {
      if (watcherFailure) {
        throw new Error("watcher failed");
      }
      activeWatchers++;
      const event = new EventEmitter<Uri>();
      const disposable = new Disposable(() => {
        activeWatchers--;
        event.dispose();
      });
      return {
        onDidChange: event.event,
        onDidCreate: event.event,
        onDidDelete: event.event,
        dispose: () => disposable.dispose()
      };
    });
    manager = new SourceControlManager(
      { logOutput: (message: string) => logs.push(message) } as unknown as Svn,
      ConstructorPolicy.LateInit,
      {} as ExtensionContext
    );
    (manager as any).scanWorkspaceFolders = () =>
      new Promise<void>((resolve, reject) => scans.push({ resolve, reject }));
  });

  teardown(() => {
    manager.dispose();
    assert.equal(activeWatchers, 0);
    assert.equal(activeListeners, 0);
    restore.reverse().forEach(fn => fn());
  });

  test("initial readiness waits for the latest enable session", async () => {
    let ready = false;
    const initialization = manager.initialize().then(() => {
      ready = true;
    });
    change(false);
    change(true);
    change(true);
    assert.equal(scans.length, 2);
    assert.equal(activeWatchers, 1);
    scans[0].resolve();
    await tick();
    assert.equal(ready, false);
    scans[1].resolve();
    await initialization;
    assert.equal(manager.state, "initialized");
  });

  test("obsolete failed scans cannot dispose the new session", async () => {
    const initialization = manager.initialize();
    change(false);
    change(true);
    scans[0].reject(new Error("obsolete"));
    await tick();
    assert.equal(activeWatchers, 1);
    scans[1].resolve();
    await initialization;
    assert.equal(logs.length, 0);
  });

  test("partial enable failure rolls back listeners and rejects initialization", async () => {
    watcherFailure = true;
    await assert.rejects(manager.initialize(), /watcher failed/);
    assert.equal(manager.state, "disposed");
    assert.equal(activeListeners, 0);
  });

  test("configuration enable failure is observed and retry owns one watcher", async () => {
    enabled = false;
    await manager.initialize();
    watcherFailure = true;
    change(true);
    await tick();
    assert.ok(logs.some(message => message.includes("watcher failed")));
    assert.equal(activeListeners, 1);
    watcherFailure = false;
    change(true);
    scans[0].resolve();
    await tick();
    assert.equal(activeWatchers, 1);
  });

  test("disabled initialization is ready and disposal settles pending readiness", async () => {
    enabled = false;
    await manager.initialize();
    await manager.isInitialized;
    assert.equal(scans.length, 0);
    manager.setState("uninitialized");
    const pending = manager.isInitialized;
    manager.dispose();
    await assert.rejects(pending, /disposed/);
  });

  test("close callbacks may re-enable without old cleanup taking new resources", async () => {
    const initialization = manager.initialize();
    scans[0].resolve();
    await initialization;
    const state = new EventEmitter<RepositoryState>();
    const status = new EventEmitter<void>();
    const changed = new EventEmitter<Uri>();
    let disposed = 0;
    let closed = 0;
    const repository = {
      workspaceRoot: "/test",
      root: "/test",
      state: RepositoryState.Idle,
      initialStatusSettled: Promise.resolve(),
      sourceControl: {},
      onDidChangeState: state.event,
      onDidChangeStatus: status.event,
      onDidChangeRepository: changed.event,
      dispose: () => {
        disposed++;
        state.fire(RepositoryState.Disposed);
      }
    };
    const listener = manager.onDidCloseRepository(() => {
      closed++;
      change(true);
    });
    (manager as any).open(repository, (manager as any).lifecycleGeneration);
    change(false);
    listener.dispose();
    state.dispose();
    status.dispose();
    changed.dispose();
    assert.equal(disposed, 1);
    assert.equal(closed, 1);
    assert.equal(activeWatchers, 1);
    scans[1].resolve();
    await tick();
    assert.equal((manager as any).enabled, true);
  });
});
