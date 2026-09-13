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

  test("does not open a queued repository after manager disposal", async () => {
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
      (manager as any).disposed = true;
      resolveRepositoryRoot(directory);
      await deferredOpen;

      assert.equal(openCalls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
