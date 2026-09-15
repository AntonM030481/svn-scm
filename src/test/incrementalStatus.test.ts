import * as assert from "assert";
import {
  ConfigurationTarget,
  Disposable,
  EventEmitter,
  Uri,
  workspace
} from "vscode";
import {
  ConstructorPolicy,
  IFileStatus,
  ISvnInfo,
  Status
} from "../common/types";
import {
  fileSnapshotsEqual,
  enableIncrementalStatusRefresh,
  refreshStatusTargets,
  isTargetCoveredByTargets,
  isTargetInWorkspace,
  mergeStatuses,
  preserveRepositoryStateInSnapshot,
  shouldPreserveRepositoryState
} from "../incrementalStatus";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { Repository as SvnRepository } from "../svnRepository";
import { Svn } from "../svn";

async function mutationFixture(
  workspaceRoot: string,
  failOperation = false,
  failInfo = false
) {
  const events: string[] = [];
  const notifiedRevisions: string[] = [];
  const targetedStatusArgs: string[][] = [];
  const workspaceChange = new EventEmitter<Uri>();
  const workspaceCreate = new EventEmitter<Uri>();
  const workspaceDelete = new EventEmitter<Uri>();
  const svnAny = new EventEmitter<Uri>();
  const svnRepository = await new SvnRepository(
    {} as Svn,
    workspaceRoot,
    workspaceRoot,
    ConstructorPolicy.LateInit,
    { revision: "42" } as ISvnInfo
  );
  svnRepository.getStatus = async () => {
    events.push("full-status");
    return [];
  };
  svnRepository.exec = async args => {
    if (args[0] === "info") {
      events.push("info");
      if (failInfo) throw new Error("info failed");
      return {
        exitCode: 0,
        stderr: "",
        stdout: '<info><entry kind="dir" path="." revision="43"/></info>'
      };
    }
    events.push("targeted-status");
    targetedStatusArgs.push([...args]);
    return { exitCode: 0, stderr: "", stdout: "<status></status>" };
  };
  const subscribe = () => ({ dispose() {} });
  const operation = async () => {
    events.push("mutation");
    if (failOperation) throw new Error("mutation failed");
    await repository.repository.getStatus({});
    return "result";
  };
  const repository: any = {
    root: workspaceRoot,
    workspaceRoot,
    statusExternal: [],
    statusIgnored: [],
    changes: { resourceStates: [] },
    conflicts: { resourceStates: [] },
    unversioned: { resourceStates: [] },
    changelists: new Map(),
    repository: svnRepository,
    disposed: false,
    disposables: [],
    _onDidDispose: new EventEmitter<void>(),
    _onDidChangeRepository: {
      fire: () => {
        events.push("notify");
        notifiedRevisions.push(svnRepository.info.revision);
      }
    },
    dispose: Repository.prototype.dispose,
    notifyRepositoryChanged: Repository.prototype.notifyRepositoryChanged,
    onDidAnyFileChanged() {},
    eventuallyUpdateWhenIdleAndWait() {},
    updateWhenIdleAndWait() {},
    whenIdle: async () => true,
    status: async () => {
      await svnRepository.getStatus({
        includeIgnored: true,
        includeExternals: false
      });
    },
    fsWatcher: {
      onDidWorkspaceChange: workspaceChange.event,
      onDidWorkspaceCreate: workspaceCreate.event,
      onDidWorkspaceDelete: workspaceDelete.event,
      onDidSvnAny: svnAny.event
    },
    addFiles: operation,
    addChangelist: operation,
    removeChangelist: operation,
    resolve: operation,
    commitFiles: operation,
    revert: operation,
    removeFiles: operation,
    pullIncomingChange: operation,
    addToIgnore: operation,
    rename: operation
  };
  const disposables: Disposable[] = [];
  svnRepository.setInfoOwner(() => !repository.disposed);
  enableIncrementalStatusRefresh(
    {
      repositories: [repository],
      onDidOpenRepository: subscribe
    } as unknown as SourceControlManager,
    disposables
  );
  return {
    repository: repository as Repository,
    events,
    notifiedRevisions,
    targetedStatusArgs,
    emitWorkspaceChange: (file: string) => workspaceChange.fire(Uri.file(file)),
    dispose: () => {
      repository.dispose();
      disposables.forEach(disposable => disposable.dispose());
    }
  };
}

function status(path: string, item: Status): IFileStatus {
  return {
    path,
    status: item,
    props: Status.NONE,
    wcStatus: {
      locked: false,
      switched: false
    }
  };
}

suite("Incremental Status Tests", () => {
  for (const [root, targets] of [
    ["/repo", [".", "./", "child/..", "/repo/", "/repo/child/.."]],
    ["C:\\Repo", [".", "child\\..", "c:/repo/", "C:\\REPO\\"]],
    ["\\\\server\\share\\repo", [".", "\\\\SERVER\\SHARE\\REPO\\"]]
  ] as Array<[string, string[]]>) {
    for (const target of targets) {
      test(`refreshes info once before notifying for root ${root} target ${target}`, async () => {
        const fixture = await mutationFixture(root);
        try {
          assert.equal(shouldPreserveRepositoryState(root, [target]), false);
          assert.deepEqual(
            mergeStatuses(
              root,
              [status("old.ts", Status.MODIFIED)],
              [target],
              []
            ),
            []
          );
          await fixture.repository.commitFiles("message", [target, target]);
          assert.deepEqual(fixture.events, [
            "mutation",
            "targeted-status",
            "info",
            "notify"
          ]);
        } finally {
          fixture.dispose();
        }
      });
    }
  }

  test("does not refresh root info for strict descendants", async () => {
    const fixture = await mutationFixture("/repo");
    try {
      await fixture.repository.commitFiles("message", [
        "src/file.ts",
        "/repo/child"
      ]);
      assert.deepEqual(fixture.events, [
        "mutation",
        "targeted-status",
        "notify"
      ]);
    } finally {
      fixture.dispose();
    }
  });

  test("refreshes info for a property mutation of the workspace subfolder", async () => {
    const fixture = await mutationFixture("/wc/client");
    Object.defineProperty(fixture.repository, "root", { value: "/wc" });
    try {
      await fixture.repository.addToIgnore(["*.tmp"], "/wc/client");
      assert.deepEqual(fixture.events, [
        "mutation",
        "targeted-status",
        "info",
        "notify"
      ]);
    } finally {
      fixture.dispose();
    }
  });

  test("does not refresh or notify when the mutation fails", async () => {
    const fixture = await mutationFixture("/repo", true);
    try {
      await assert.rejects(
        fixture.repository.commitFiles("message", ["."]),
        /mutation failed/
      );
      assert.deepEqual(fixture.events, ["mutation"]);
    } finally {
      fixture.dispose();
    }
  });

  test("does not publish stale info when its refresh fails", async () => {
    const fixture = await mutationFixture("/repo", false, true);
    try {
      assert.equal(
        await fixture.repository.commitFiles("message", ["."]),
        "result"
      );
      assert.deepEqual(fixture.events, ["mutation", "targeted-status", "info"]);
    } finally {
      fixture.dispose();
    }
  });

  test("does not notify after disposal while info refresh is pending", async () => {
    const fixture = await mutationFixture("/repo");
    let completeInfo!: () => void;
    let infoStarted!: () => void;
    const started = new Promise<void>(resolve => {
      infoStarted = resolve;
    });
    const exec = fixture.repository.repository.exec;
    fixture.repository.repository.exec = async args => {
      const result = await exec(args);
      if (args[0] === "info") {
        infoStarted();
        await new Promise<void>(resolve => {
          completeInfo = resolve;
        });
      }
      return result;
    };
    try {
      const mutation = fixture.repository.commitFiles("message", ["."]);
      await started;
      fixture.repository.dispose();
      completeInfo();
      await mutation;
      assert.deepEqual(fixture.events, ["mutation", "targeted-status", "info"]);
    } finally {
      fixture.dispose();
    }
  });

  test("does not launch info when disposed before mutation completion", async () => {
    const fixture = await mutationFixture("/repo");
    const getStatus = fixture.repository.repository.getStatus;
    fixture.repository.repository.getStatus = async params => {
      const statuses = await getStatus(params);
      fixture.repository.dispose();
      return statuses;
    };
    try {
      await fixture.repository.commitFiles("message", ["."]);
      assert.deepEqual(fixture.events, ["mutation", "targeted-status"]);
    } finally {
      fixture.dispose();
    }
  });

  for (const recover of [false, true]) {
    test(`retries dirty info before a descendant notification, recover=${recover}`, async () => {
      const fixture = await mutationFixture("/repo", false, true);
      try {
        assert.equal(
          await fixture.repository.commitFiles("root", ["."]),
          "result"
        );
        assert.equal(fixture.repository.repository.isInfoCurrent, false);
        assert.deepEqual(fixture.notifiedRevisions, []);
        if (recover) {
          const exec = fixture.repository.repository.exec;
          fixture.repository.repository.exec = async args => {
            if (args[0] !== "info") return exec(args);
            fixture.events.push("info");
            return {
              exitCode: 0,
              stderr: "",
              stdout: '<info><entry revision="43"/></info>'
            };
          };
        }
        assert.equal(
          await fixture.repository.commitFiles("descendant", ["file.ts"]),
          "result"
        );
        assert.equal(
          fixture.events.filter(event => event === "info").length,
          2
        );
        assert.deepEqual(fixture.notifiedRevisions, recover ? ["43"] : []);
      } finally {
        fixture.dispose();
      }
    });
  }

  test("orders descendant notification after a pending root info refresh", async () => {
    const fixture = await mutationFixture("/repo");
    let finish!: () => void;
    let markStarted!: () => void;
    let markQueued!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const queued = new Promise<void>(resolve => {
      markQueued = resolve;
    });
    const exec = fixture.repository.repository.exec;
    fixture.repository.repository.exec = async args => {
      const result = await exec(args);
      if (args[0] === "info") {
        markStarted();
        await new Promise<void>(resolve => {
          finish = resolve;
        });
      }
      return result;
    };
    const ensure = fixture.repository.repository.ensureInfoCurrent.bind(
      fixture.repository.repository
    );
    let callers = 0;
    fixture.repository.repository.ensureInfoCurrent = async () => {
      if (++callers === 2) markQueued();
      return ensure();
    };
    try {
      const root = fixture.repository.commitFiles("root", ["."]);
      await started;
      const descendant = fixture.repository.commitFiles("descendant", [
        "file.ts"
      ]);
      await queued;
      assert.deepEqual(fixture.notifiedRevisions, []);
      finish();
      await Promise.all([root, descendant]);
      assert.deepEqual(fixture.notifiedRevisions, ["43", "43"]);
      assert.equal(fixture.events.filter(event => event === "info").length, 1);
    } finally {
      fixture.dispose();
    }
  });
  test("keeps explicit targets when watcher work is already queued", async () => {
    const svnConfiguration = workspace.getConfiguration("svn");
    const previousAutorefresh =
      svnConfiguration.inspect<boolean>("autorefresh")?.globalValue;
    await svnConfiguration.update(
      "autorefresh",
      true,
      ConfigurationTarget.Global
    );
    const fixture = await mutationFixture("/repo");
    try {
      fixture.emitWorkspaceChange("/repo/watcher.ts");
      await new Promise(resolve => setImmediate(resolve));
      fixture.events.length = 0;
      fixture.targetedStatusArgs.length = 0;

      await refreshStatusTargets(fixture.repository, ["/repo/explicit.ts"]);

      assert.equal(fixture.targetedStatusArgs.length, 1);
      const args = fixture.targetedStatusArgs[0];
      assert.ok(args.some(arg => /explicit\.ts$/.test(arg)));
      assert.ok(args.some(arg => /watcher\.ts$/.test(arg)));
      assert.equal(fixture.events.includes("full-status"), false);
    } finally {
      fixture.dispose();
      await svnConfiguration.update(
        "autorefresh",
        previousAutorefresh,
        ConfigurationTarget.Global
      );
    }
  });

  test("targeted refresh waits for idle before starting status", async () => {
    const fixture = await mutationFixture("/repo");
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>(resolve => {
      releaseIdle = resolve;
    });
    const order: string[] = [];
    (fixture.repository as any).whenIdle = async () => {
      order.push("wait-idle");
      await idleGate;
      return true;
    };
    const status = (fixture.repository as any).status.bind(fixture.repository);
    (fixture.repository as any).status = async () => {
      order.push("status");
      return status();
    };

    try {
      const refresh = refreshStatusTargets(fixture.repository, [
        "/repo/explicit.ts"
      ]);
      await Promise.resolve();
      assert.deepEqual(order, ["wait-idle"]);
      releaseIdle();
      await refresh;
      assert.deepEqual(order, ["wait-idle", "status"]);
      assert.equal(fixture.events.includes("targeted-status"), true);
    } finally {
      fixture.dispose();
    }
  });

  test("replaces only the targeted file", () => {
    const current = [
      status("src/a.ts", Status.MODIFIED),
      status("src/b.ts", Status.MODIFIED)
    ];
    const updated = [status("src/a.ts", Status.CONFLICTED)];

    const result = mergeStatuses("/repo", current, ["/repo/src/a.ts"], updated);

    assert.equal(result.length, 2);
    assert.equal(
      result.find(item => item.path === "src/a.ts")!.status,
      Status.CONFLICTED
    );
    assert.equal(
      result.find(item => item.path === "src/b.ts")!.status,
      Status.MODIFIED
    );
  });

  test("removes a reverted file when targeted status is empty", () => {
    const current = [
      status("src/a.ts", Status.MODIFIED),
      status("src/b.ts", Status.MODIFIED)
    ];

    const result = mergeStatuses("/repo", current, ["/repo/src/a.ts"], []);

    assert.deepEqual(
      result.map(item => item.path),
      ["src/b.ts"]
    );
  });

  test("replaces a targeted subtree and preserves other changes", () => {
    const current = [
      status("src/feature/a.ts", Status.MODIFIED),
      status("src/feature/b.ts", Status.UNVERSIONED),
      status("src/other.ts", Status.MODIFIED)
    ];
    const updated = [status("src/feature/c.ts", Status.ADDED)];

    const result = mergeStatuses(
      "/repo",
      current,
      ["/repo/src/feature"],
      updated
    );

    assert.deepEqual(result.map(item => item.path).sort(), [
      "src/feature/c.ts",
      "src/other.ts"
    ]);
  });

  test("preserves working copy state on a targeted refresh", () => {
    const merged = mergeStatuses(
      "/repo",
      [
        status("src/a.ts", Status.MODIFIED),
        status("src/b.ts", Status.MODIFIED)
      ],
      ["/repo/src/a.ts"],
      [status("src/a.ts", Status.MODIFIED)]
    );
    const result = preserveRepositoryStateInSnapshot(merged, true, true);
    const repositoryState = result.find(item => item.path === ".");

    assert.ok(repositoryState);
    assert.equal(repositoryState.status, Status.INCOMPLETE);
    assert.equal(repositoryState.wcStatus.locked, true);
  });

  test("does not mix preserved state into a real root status", () => {
    const rootStatus = status(".", Status.NORMAL);
    rootStatus.props = Status.MODIFIED;

    const result = preserveRepositoryStateInSnapshot(
      [rootStatus, status("src/a.ts", Status.MODIFIED)],
      true,
      true
    );
    const rootStatuses = result.filter(item => item.path === ".");

    assert.equal(rootStatuses.length, 2);
    assert.equal(rootStatuses[0].props, Status.MODIFIED);
    assert.equal(rootStatuses[1].status, Status.INCOMPLETE);
    assert.equal(rootStatuses[1].wcStatus.locked, true);
  });

  test("uses root refresh as authoritative working copy state", () => {
    assert.equal(
      shouldPreserveRepositoryState("/repo", ["/repo/src/a.ts"]),
      true
    );
    assert.equal(shouldPreserveRepositoryState("/repo", ["/repo"]), false);
    assert.equal(shouldPreserveRepositoryState("/repo", ["."]), false);
  });

  test("scopes targets to one workspace folder", () => {
    const workspaceRoot = "/wc/client";

    assert.equal(
      isTargetInWorkspace(workspaceRoot, "/wc/client/src/a.ts"),
      true
    );
    assert.equal(
      isTargetInWorkspace(workspaceRoot, "/wc/server/src/b.ts"),
      false
    );
    assert.equal(
      isTargetInWorkspace(workspaceRoot, "../server/src/b.ts"),
      false
    );
  });

  test("does not merge sibling workspace statuses", () => {
    const current = [status("src/a.ts", Status.MODIFIED)];
    const updated = [status("../server/src/b.ts", Status.MODIFIED)];

    const result = mergeStatuses(
      "/wc/client",
      current,
      ["/wc/server/src/b.ts"],
      updated
    );

    assert.deepEqual(
      result.map(item => item.path),
      ["src/a.ts"]
    );
  });

  test("isolates Windows workspace folders from the same working copy", () => {
    const programming = "D:\\WOT\\programming";
    const bigworldScripts = "D:\\WOT\\game\\res\\bigworld\\scripts";
    const avatarFilter =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";
    const siblingRelative =
      "..\\..\\..\\..\\programming\\bigworld_client\\client\\avatar_filter.cpp";

    assert.equal(isTargetInWorkspace(programming, avatarFilter), true);
    assert.equal(isTargetInWorkspace(bigworldScripts, avatarFilter), false);
    assert.equal(isTargetInWorkspace(bigworldScripts, siblingRelative), false);
  });

  test("drops an already polluted sibling status from a workspace snapshot", () => {
    const workspaceRoot = "D:\\WOT\\game\\res\\bigworld\\scripts";
    const current = [
      status(
        "..\\..\\..\\..\\programming\\bigworld_client\\client\\avatar_filter.cpp",
        Status.MODIFIED
      ),
      status("server\\base.py", Status.MODIFIED)
    ];

    const result = mergeStatuses(
      workspaceRoot,
      current,
      ["server\\base.py"],
      [status("server\\base.py", Status.MODIFIED)]
    );

    assert.deepEqual(
      result.map(item => item.path),
      ["server\\base.py"]
    );
  });

  test("recognizes filesystem echoes from an active targeted operation", () => {
    const workspaceRoot = "D:\\WOT\\programming";
    const avatarFilter =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";
    const otherFile =
      "D:\\WOT\\programming\\bigworld_client\\client\\boids_filter.cpp";

    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, avatarFilter, [avatarFilter]),
      true
    );
    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, otherFile, [avatarFilter]),
      false
    );
  });

  test("recognizes filesystem echoes below a targeted directory", () => {
    const workspaceRoot = "D:\\WOT\\programming";
    const directory = "D:\\WOT\\programming\\bigworld_client\\client";
    const file =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";

    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, file, [directory]),
      true
    );
  });

  test("matches a delayed filesystem echo when file metadata is unchanged", () => {
    assert.equal(
      fileSnapshotsEqual(
        { exists: true, mtime: 10, ctime: 20, size: 30 },
        { exists: true, mtime: 10, ctime: 20, size: 30 }
      ),
      true
    );
  });

  test("does not suppress a real edit after an svn operation", () => {
    assert.equal(
      fileSnapshotsEqual(
        { exists: true, mtime: 10, ctime: 20, size: 30 },
        { exists: true, mtime: 11, ctime: 21, size: 30 }
      ),
      false
    );
  });
});
