import * as assert from "assert";
import * as path from "path";
import { commands, EventEmitter, Uri, window } from "vscode";
import { ChangeList } from "../commands/changeList";
import { RepositoryState, Status } from "../common/types";
import { SourceControlManager } from "../source_control_manager";

suite("Validated repository routing", () => {
  function fixture() {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.lifecycleGeneration = 0;
    manager.openRepositories = [];
    manager.routingValidations = new WeakMap();
    manager.logRepositoryLifecycle = () => undefined;
    manager.scanExternals = () => undefined;
    manager.scanIgnored = () => undefined;
    const emitters: EventEmitter<any>[] = [];
    for (const name of [
      "OpenRepository",
      "CloseRepository",
      "ChangeRepository",
      "ChangeStatusRepository"
    ]) {
      const emitter = new EventEmitter<any>();
      emitters.push(emitter);
      manager[`_onDid${name}`] = emitter;
    }
    function add(root: string) {
      const status = new EventEmitter<void>();
      const change = new EventEmitter<Uri>();
      const state = new EventEmitter<RepositoryState>();
      emitters.push(status, change, state);
      const repository: any = {
        root,
        workspaceRoot: root,
        statusExternal: [],
        statusIgnored: [],
        isInitialStatusPending: false,
        initialStatusSettled: Promise.resolve(),
        ensureStatus: async () => undefined,
        state: RepositoryState.Idle,
        sourceControl: {},
        onDidChangeStatus: status.event,
        onDidChangeRepository: change.event,
        onDidChangeState: state.event,
        getResourceFromFile: () => undefined,
        getInfo: async () => {
          calls += 1;
        },
        dispose: () => undefined
      };
      let calls = 0;
      manager.open(repository, 0);
      return { repository, status, change, calls: () => calls };
    }
    return {
      manager: manager as SourceControlManager,
      add,
      dispose: () => {
        [...manager.openRepositories].forEach(entry => entry.dispose());
        emitters.forEach(emitter => emitter.dispose());
      }
    };
  }

  const root = path.resolve("routing-root");
  const file = Uri.file(path.join(root, "file.txt"));

  for (const type of [
    Status.NORMAL,
    Status.MODIFIED,
    Status.ADDED,
    Status.UNVERSIONED,
    Status.IGNORED
  ]) {
    test(`routes known ${type} resource without SVN`, async () => {
      const f = fixture();
      const owner = f.add(root);
      owner.repository.getResourceFromFile = () => ({ type });
      try {
        assert.strictEqual(
          await f.manager.getRepositoryFromUri(file),
          type === Status.UNVERSIONED || type === Status.IGNORED
            ? null
            : owner.repository
        );
        assert.strictEqual(owner.calls(), 0);
      } finally {
        f.dispose();
      }
    });
  }

  test("startup routes unknown paths immediately without validation", async () => {
    const f = fixture();
    const owner = f.add(root);
    owner.repository.isInitialStatusPending = true;
    try {
      assert.strictEqual(
        await f.manager.getRepositoryFromUri(file),
        owner.repository
      );
      assert.strictEqual(owner.calls(), 0);
    } finally {
      f.dispose();
    }
  });

  test("mixed changelist selection rejects an unknown unversioned file before prompting or mutation", async () => {
    const f = fixture();
    const owner = f.add(root);
    const unknown = Uri.file(path.join(root, "new.txt"));
    owner.repository.getResourceFromFile = (uri: Uri) =>
      uri.toString() === file.toString()
        ? { type: Status.MODIFIED }
        : undefined;
    let infoCalls = 0;
    let mutationCalls = 0;
    let prompts = 0;
    const errors: string[] = [];
    owner.repository.getInfo = async () => {
      infoCalls += 1;
      throw new Error("Unversioned");
    };
    owner.repository.addChangelist = async () => {
      mutationCalls += 1;
    };
    const originalExecute = commands.executeCommand;
    const originalError = window.showErrorMessage;
    const originalPick = window.showQuickPick;
    (commands as any).executeCommand = async () => f.manager;
    (window as any).showErrorMessage = async (message: string) => {
      errors.push(message);
    };
    (window as any).showQuickPick = async () => {
      prompts += 1;
    };
    try {
      const command = Object.create(ChangeList.prototype) as ChangeList;
      await command.execute(file, [file, unknown]);
      assert.strictEqual(infoCalls, 1);
      assert.strictEqual(mutationCalls, 0);
      assert.strictEqual(prompts, 0);
      assert.deepStrictEqual(errors, [
        "Some Files are not under version control and cannot be added to a change list"
      ]);
    } finally {
      commands.executeCommand = originalExecute;
      window.showErrorMessage = originalError;
      window.showQuickPick = originalPick;
      f.dispose();
    }
  });

  test("shares concurrent info but never caches settled validity", async () => {
    const f = fixture();
    const owner = f.add(root);
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    owner.repository.getInfo = async () => {
      calls += 1;
      await gate;
    };
    try {
      const first = f.manager.getRepositoryFromUri(file);
      const second = f.manager.getRepositoryFromUri(file);
      assert.strictEqual(calls, 1);
      release();
      assert.deepStrictEqual(await Promise.all([first, second]), [
        owner.repository,
        owner.repository
      ]);
      assert.strictEqual(
        await f.manager.getRepositoryFromUri(file),
        owner.repository
      );
      assert.strictEqual(calls, 2);
      owner.repository.getInfo = async () => {
        calls += 1;
        throw new Error("Unversioned now");
      };
      assert.strictEqual(await f.manager.getRepositoryFromUri(file), null);
      assert.strictEqual(calls, 3);
    } finally {
      release();
      f.dispose();
    }
  });

  test("caches routing order without reordering the repository registry", () => {
    const f = fixture();
    const ancestor = f.add(root);
    const nested = f.add(path.join(root, "nested"));
    try {
      assert.strictEqual(
        f.manager.getRepository(
          Uri.file(path.join(root, "nested", "file.txt"))
        ),
        nested.repository
      );
      assert.deepStrictEqual(
        f.manager.openRepositories.map(entry => entry.repository),
        [ancestor.repository, nested.repository]
      );

      const deepest = f.add(path.join(root, "nested", "deepest"));
      assert.strictEqual(
        f.manager.getRepository(
          Uri.file(path.join(root, "nested", "deepest", "file.txt"))
        ),
        deepest.repository
      );
    } finally {
      f.dispose();
    }
  });

  for (const boundary of ["statusExternal", "statusIgnored"]) {
    test(`${boundary} cannot fall through a nested owner to its ancestor`, async () => {
      const f = fixture();
      const ancestor = f.add(root);
      const nested = f.add(path.join(root, "nested"));
      nested.repository[boundary] = [{ path: "blocked" }];
      const uri = Uri.file(path.join(root, "nested", "blocked", "file.txt"));
      try {
        assert.strictEqual(f.manager.getRepository(uri), null);
        assert.strictEqual(await f.manager.getRepositoryFromUri(uri), null);
        assert.strictEqual(ancestor.calls() + nested.calls(), 0);
        const child = f.add(path.join(root, "nested", "blocked"));
        assert.strictEqual(
          await f.manager.getRepositoryFromUri(uri),
          child.repository
        );
        assert.strictEqual(child.calls(), 1);
        assert.strictEqual(ancestor.calls() + nested.calls(), 0);
      } finally {
        f.dispose();
      }
    });
  }

  test("a failed nested validation never retries through the parent", async () => {
    const f = fixture();
    const ancestor = f.add(root);
    const nested = f.add(path.join(root, "nested"));
    nested.repository.getInfo = async () => {
      throw new Error("Unversioned");
    };
    try {
      assert.strictEqual(
        await f.manager.getRepositoryFromUri(
          Uri.file(path.join(root, "nested", "new.txt"))
        ),
        null
      );
      assert.strictEqual(ancestor.calls(), 0);
    } finally {
      f.dispose();
    }
  });

  for (const change of ["status", "repository", "close", "nested-owner"]) {
    test(`rejects validation invalidated by ${change}`, async () => {
      const f = fixture();
      const owner = f.add(root);
      let release!: () => void;
      owner.repository.getInfo = () =>
        new Promise<void>(resolve => {
          release = resolve;
        });
      try {
        const pending = f.manager.getRepositoryFromUri(file);
        if (change === "status") {
          owner.status.fire();
        }
        if (change === "repository") {
          owner.change.fire(file);
        }
        if (change === "close") {
          f.manager.openRepositories[0].dispose();
        }
        if (change === "nested-owner") {
          f.add(file.fsPath);
        }
        release();
        assert.strictEqual(await pending, null);
      } finally {
        release();
        f.dispose();
      }
    });
  }
});
