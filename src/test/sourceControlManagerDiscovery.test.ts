import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uri } from "vscode";
import { SvnFinder } from "../svnFinder";
import { cancelDebounces } from "../decorators";
import {
  getSvnRepositoryPathFromMetadata,
  isSvnMetadataLookalikeDirectory,
  SourceControlManager
} from "../source_control_manager";

suite("Source control repository discovery", () => {
  for (const version of ["1.6.23", "1.14.0"]) {
    for (const source of [
      "explicit",
      "automatic",
      "promoted",
      "promoted subfolder",
      "nested owner"
    ]) {
      const automaticChild = source !== "explicit";
      test(`registers a later parent with SVN ${version}, child source=${source}`, () => {
        const manager = Object.create(SourceControlManager.prototype) as any;
        manager.enabled = true;
        manager.disposed = false;
        manager.lifecycleGeneration = 0;
        manager._svn = { version };
        manager.openRepositories = [];
        manager.provisionalLegacyRepositories = new WeakSet();
        const events: string[] = [];
        manager.open = (repository: any) => {
          const entry = {
            repository,
            dispose: () => {
              events.push(`close:${repository.workspaceRoot}`);
              manager.openRepositories = manager.openRepositories.filter(
                (item: any) => item !== entry
              );
            }
          };
          manager.openRepositories.push(entry);
          events.push(`open:${repository.workspaceRoot}`);
        };
        const makeRepository = (workspaceRoot: string) => ({
          workspaceRoot,
          root: workspaceRoot,
          statusExternal: [],
          statusIgnored: []
        });
        const parent = makeRepository("/parent");
        const child = makeRepository("/parent/child");
        const sibling = makeRepository("/other");
        const nested = makeRepository("/parent/child/subfolder");
        manager.registerDiscoveredRepository(child, 0, automaticChild);
        manager.registerDiscoveredRepository(sibling, 0, true);
        if (source === "nested owner") {
          manager.registerDiscoveredRepository(nested, 0, false);
        }
        const folders =
          source.startsWith("promoted") || source === "nested owner"
            ? [
                {
                  uri: Uri.file(
                    source === "promoted"
                      ? "/parent/child"
                      : "/parent/child/subfolder"
                  )
                }
              ]
            : [];
        manager.registerDiscoveredRepository(parent, 0, true, folders);
        const replaced =
          version === "1.6.23" &&
          (source === "automatic" || source === "nested owner");
        assert.deepStrictEqual(
          new Set(
            manager.openRepositories.map((entry: any) => entry.repository)
          ),
          new Set([
            ...(replaced ? [] : [child]),
            sibling,
            ...(source === "nested owner" ? [nested] : []),
            parent
          ])
        );
        assert.deepStrictEqual(events, [
          "open:/parent/child",
          "open:/other",
          ...(source === "nested owner"
            ? ["open:/parent/child/subfolder"]
            : []),
          ...(replaced ? ["close:/parent/child"] : []),
          "open:/parent"
        ]);
      });
    }
  }

  test("stops reconciliation when a close listener invalidates the lifecycle", () => {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.lifecycleGeneration = 0;
    manager._svn = { version: "1.6.23" };
    const first = { workspaceRoot: "/parent/first" };
    const second = { workspaceRoot: "/parent/second" };
    manager.provisionalLegacyRepositories = new WeakSet([first, second]);
    let parentDisposals = 0;
    manager.openRepositories = [
      {
        repository: first,
        dispose: () => {
          manager.lifecycleGeneration += 2;
          manager.openRepositories = [];
        }
      },
      {
        repository: second,
        dispose: () => assert.fail("child was closed twice")
      }
    ];
    manager.registerDiscoveredRepository(
      {
        workspaceRoot: "/parent",
        dispose: () => {
          parentDisposals += 1;
        }
      },
      0,
      true
    );
    assert.strictEqual(parentDisposals, 1);
  });

  test("stale registration cannot replace a provisional legacy child", () => {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.lifecycleGeneration = 2;
    let disposed = 0;
    manager.open = () => assert.fail("stale request opened a repository");
    manager.registerDiscoveredRepository(
      {
        dispose: () => {
          disposed += 1;
        }
      },
      0,
      true
    );
    assert.strictEqual(disposed, 1);
  });

  test("directory-create queue explicitly disables recursive discovery", async () => {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.possibleSvnRepositoryPaths = new Map();
    let accept!: (args: unknown[]) => void;
    const scanned = new Promise<unknown[]>(resolve => {
      accept = resolve;
    });
    manager.tryOpenRepository = async (...args: unknown[]) => {
      accept(args);
    };
    try {
      manager.eventuallyScanPossibleSvnRepository("created", true);
      assert.deepStrictEqual(await scanned, [
        "created",
        1,
        { allowNested: true, recursive: false }
      ]);
    } finally {
      cancelDebounces(manager);
    }
  });

  for (const recursive of [false, true]) {
    test(`honors recursive=${recursive} even with configured depth 10`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
      fs.mkdirSync(path.join(root, "child", ".svn"), { recursive: true });
      const manager = Object.create(SourceControlManager.prototype) as any;
      manager.enabled = true;
      manager.disposed = false;
      manager.lifecycleGeneration = 0;
      manager.openRepositories = [];
      manager.maxDepth = 10;
      manager.ignoreList = [];
      let lookups = 0;
      manager._svn = {
        version: "1.14.0",
        getRepositoryRoot: async () => {
          lookups += 1;
          // Stop after proving that a descendant was visited.
          manager.enabled = false;
          return root;
        }
      };
      try {
        await manager.tryOpenRepository(root, 1, {
          allowNested: true,
          recursive
        });
        assert.strictEqual(lookups, recursive ? 1 : 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("distinguishes modern nested candidates from legacy parent ownership", () => {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.getRepository = () => ({});
    manager.hasExactRepository = () => false;
    manager._svn = { version: "1.14.0" };
    assert.strictEqual(manager.isDiscoveryCandidateOwned("child", true), false);
    assert.strictEqual(manager.isDiscoveryCandidateOwned("child", false), true);
    manager._svn.version = "1.6.23";
    assert.strictEqual(manager.isDiscoveryCandidateOwned("child", true), true);
  });

  for (const [version, owned] of [
    ["1.6.17-SlikSvn-tag-1.6.17@1130898-X64", true],
    ["1.6.23 (r12345)", true],
    ["1.7.0-SlikSvn-tag@12345", false],
    ["1.14.0 (r12345)", false]
  ] as const) {
    test(`uses validated SVN capability for ${version}`, async () => {
      const manager = Object.create(SourceControlManager.prototype) as any;
      manager.getRepository = () => ({});
      manager.hasExactRepository = () => false;
      manager._svn = await new SvnFinder().checkSvnVersion({
        path: "svn",
        version
      });
      assert.strictEqual(
        manager.isDiscoveryCandidateOwned("child", true),
        owned
      );
    });
  }

  for (const legacyParent of [false, true]) {
    test(`does not construct a duplicate when ${legacyParent ? "a legacy parent" : "an exact owner"} opens during SVN lookup`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
      fs.mkdirSync(path.join(root, ".svn"));
      const manager = Object.create(SourceControlManager.prototype) as any;
      manager.enabled = true;
      manager.disposed = false;
      manager.lifecycleGeneration = 0;
      manager.openRepositories = [];
      let opens = 0;
      let constructions = 0;
      manager.extensionContact = {
        get secrets() {
          constructions += 1;
          throw new Error("Duplicate construction");
        }
      };
      manager._svn = {
        version: legacyParent ? "1.6.23" : "1.14.0",
        getRepositoryRoot: async () => root,
        open: async () => {
          opens += 1;
          manager.openRepositories.push({
            repository: {
              root: legacyParent ? path.dirname(root) : root,
              workspaceRoot: legacyParent ? path.dirname(root) : root,
              statusExternal: [],
              statusIgnored: []
            }
          });
          return {};
        }
      };
      try {
        await manager.tryOpenRepository(root, 1, { allowNested: true });
        assert.strictEqual(opens, 1);
        assert.strictEqual(constructions, 0);
        assert.strictEqual(manager.openRepositories.length, 1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("does not resume a workspace scan in a newer enable generation", async () => {
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.lifecycleGeneration = 0;
    const calls: string[] = [];
    manager.tryOpenRepository = async (candidate: string) => {
      calls.push(candidate);
      manager.lifecycleGeneration += 2;
    };
    const folders = ["first", "second"].map(name => ({ uri: Uri.file(name) }));
    await manager.scanWorkspaceFolders(0, folders);
    assert.deepStrictEqual(calls, [folders[0].uri.fsPath]);
  });

  test("keeps SVN 1.6 nested administration directories with their owner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
    const child = path.join(root, "child");
    fs.mkdirSync(path.join(child, ".svn"), { recursive: true });
    const manager = Object.create(SourceControlManager.prototype) as any;
    manager.enabled = true;
    manager.disposed = false;
    manager.lifecycleGeneration = 0;
    manager.hasExactRepository = () => false;
    manager.getRepository = () => ({ workspaceRoot: root });
    let lookups = 0;
    manager._svn = {
      version: "1.6.23",
      getRepositoryRoot: async () => {
        lookups += 1;
      }
    };
    try {
      await manager.tryOpenRepository(child, 1, { allowNested: true });
      assert.strictEqual(lookups, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("extracts working-copy roots from SVN metadata paths", () => {
    const dotSvnChild = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn/wc.db",
      ".svn"
    );
    const dotSvnDirectory = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn",
      ".svn"
    );
    const aspNetSvnChild = getSvnRepositoryPathFromMetadata(
      "C:\\workspace\\project\\_svn\\entries",
      "_svn"
    );

    assert.strictEqual(dotSvnChild, "/workspace/project");
    assert.strictEqual(dotSvnDirectory, "/workspace/project");
    assert.strictEqual(aspNetSvnChild, "C:\\workspace\\project");
  });

  test("ignores ordinary files and SVN-like directory names", () => {
    const ordinaryFile = getSvnRepositoryPathFromMetadata(
      "/workspace/project/file.ts",
      ".svn"
    );
    const lookalikeDirectory = getSvnRepositoryPathFromMetadata(
      "/workspace/project/.svn-backup/file",
      ".svn"
    );

    assert.strictEqual(ordinaryFile, undefined);
    assert.strictEqual(lookalikeDirectory, undefined);
    assert.equal(
      isSvnMetadataLookalikeDirectory("/workspace/project/.svn-backup"),
      true
    );
    assert.equal(
      isSvnMetadataLookalikeDirectory("C:\\workspace\\project\\_svn.old"),
      true
    );
  });

  test("uses only created directories as bounded discovery candidates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
    const directory = path.join(root, "moved-working-copy");
    const ordinaryFile = path.join(root, "ordinary.txt");
    fs.mkdirSync(directory);
    fs.mkdirSync(path.join(directory, ".svn"));
    fs.writeFileSync(ordinaryFile, "ordinary");

    const manager = Object.create(
      SourceControlManager.prototype
    ) as SourceControlManager;
    const candidates: string[] = [];
    (manager as any).enabled = true;
    (manager as any).disposed = false;
    (manager as any).lifecycleGeneration = 0;
    (manager as any).openRepositories = [];
    (manager as any).getRepository = () => null;
    (manager as any).eventuallyScanPossibleSvnRepository = (
      candidate: string
    ) => candidates.push(candidate);

    try {
      await (manager as any).onPossibleSvnRepositoryDirectoryCreate(
        Uri.file(directory)
      );
      await (manager as any).onPossibleSvnRepositoryDirectoryCreate(
        Uri.file(ordinaryFile)
      );

      assert.deepEqual(candidates, [Uri.file(directory).fsPath]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not schedule discovery after manager disposal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
    const directory = path.join(root, "moved-working-copy");
    fs.mkdirSync(directory);

    const manager = Object.create(
      SourceControlManager.prototype
    ) as SourceControlManager;
    const candidates: string[] = [];
    (manager as any).enabled = true;
    (manager as any).disposed = false;
    (manager as any).lifecycleGeneration = 0;
    (manager as any).openRepositories = [];
    (manager as any).getRepository = () => null;
    (manager as any).eventuallyScanPossibleSvnRepository = (
      candidate: string
    ) => candidates.push(candidate);

    try {
      const deferredDiscovery = (
        manager as any
      ).onPossibleSvnRepositoryDirectoryCreate(Uri.file(directory));
      (manager as any).disposed = true;
      (manager as any).enabled = false;
      await deferredDiscovery;

      assert.deepEqual(candidates, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("checks a created directory owned only by a parent repository", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
    const directory = path.join(root, "nested-working-copy");
    fs.mkdirSync(directory);

    const manager = Object.create(
      SourceControlManager.prototype
    ) as SourceControlManager;
    const candidates: string[] = [];
    (manager as any).enabled = true;
    (manager as any).disposed = false;
    (manager as any).lifecycleGeneration = 0;
    (manager as any).openRepositories = [
      { repository: { root, workspaceRoot: root } }
    ];
    (manager as any).eventuallyScanPossibleSvnRepository = (
      candidate: string
    ) => candidates.push(candidate);

    try {
      await (manager as any).onPossibleSvnRepositoryDirectoryCreate(
        Uri.file(directory)
      );

      assert.deepEqual(candidates, [Uri.file(directory).fsPath]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const stage of ["root lookup", "SVN open"]) {
    for (const transition of ["disable", "dispose", "disable/re-enable"]) {
      test(`cancels discovery during ${stage} after ${transition}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-discovery-"));
        const directory = path.join(root, "moved-working-copy");
        fs.mkdirSync(path.join(directory, ".svn"), { recursive: true });

        const manager = Object.create(
          SourceControlManager.prototype
        ) as SourceControlManager;
        let signalLookupStarted!: () => void;
        const lookupStarted = new Promise<void>(resolve => {
          signalLookupStarted = resolve;
        });
        let resolveRepositoryRoot!: (value: string) => void;
        const repositoryRoot = new Promise<string>(resolve => {
          resolveRepositoryRoot = resolve;
        });
        let openCalls = 0;
        let constructions = 0;
        (manager as any).disposed = false;
        (manager as any).enabled = true;
        (manager as any).lifecycleGeneration = 0;
        (manager as any).openRepositories = [];
        (manager as any).extensionContact = {
          get secrets() {
            constructions += 1;
            throw new Error("Stale discovery constructed a Repository");
          }
        };
        (manager as any)._svn = {
          version: "1.14.0",
          getRepositoryRoot: () => {
            if (stage !== "root lookup") {
              return Promise.resolve(directory);
            }
            signalLookupStarted();
            return repositoryRoot;
          },
          open: async () => {
            openCalls += 1;
            signalLookupStarted();
            await repositoryRoot;
            return {};
          }
        };

        try {
          const deferredOpen = manager.tryOpenRepository(directory, 1, {
            allowNested: true
          });
          await lookupStarted;
          (manager as any).enabled = false;
          (manager as any).lifecycleGeneration += 1;
          if (transition === "dispose") {
            (manager as any).disposed = true;
          } else if (transition === "disable/re-enable") {
            (manager as any).enabled = true;
            (manager as any).lifecycleGeneration += 1;
          }
          resolveRepositoryRoot(directory);
          await deferredOpen;

          assert.equal(openCalls, stage === "SVN open" ? 1 : 0);
          assert.equal(constructions, 0);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
