import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uri } from "vscode";
import {
  getSvnRepositoryPathFromMetadata,
  isSvnMetadataLookalikeDirectory,
  SourceControlManager
} from "../source_control_manager";

suite("Source control repository discovery", () => {
  test("does not construct a duplicate when another open wins during SVN lookup", async () => {
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
      getRepositoryRoot: async () => root,
      open: async () => {
        opens += 1;
        manager.openRepositories.push({
          repository: { root, workspaceRoot: root }
        });
        return {};
      }
    };
    try {
      await manager.tryOpenRepository(root, 1, true);
      assert.strictEqual(opens, 1);
      assert.strictEqual(constructions, 0);
      assert.strictEqual(manager.openRepositories.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
      await manager.tryOpenRepository(child, 1, true);
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

  test("does not open a queued repository after manager disable", async () => {
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
    (manager as any).disposed = false;
    (manager as any).enabled = true;
    (manager as any).lifecycleGeneration = 0;
    (manager as any).openRepositories = [];
    (manager as any)._svn = {
      getRepositoryRoot: () => {
        signalLookupStarted();
        return repositoryRoot;
      },
      open: async () => {
        openCalls += 1;
      }
    };

    try {
      const deferredOpen = manager.tryOpenRepository(directory, 1, true);
      await lookupStarted;
      (manager as any).enabled = false;
      (manager as any).lifecycleGeneration += 1;
      resolveRepositoryRoot(directory);
      await deferredOpen;

      assert.equal(openCalls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
