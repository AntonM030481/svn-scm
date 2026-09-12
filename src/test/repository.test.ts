import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "path";
import { commands, EventEmitter, Uri, window, workspace } from "vscode";
import { ItemLogProvider } from "../historyView/itemLogProvider";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import * as testUtil from "./testUtil";

suite("Repository Tests", () => {
  let repoUri: Uri;
  let checkoutDir: Uri;
  let sourceControlManager: SourceControlManager;

  suiteSetup(async () => {
    await testUtil.activeExtension();

    repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    checkoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      checkoutDir
    )) as SourceControlManager;
  });

  suiteTeardown(() => {
    sourceControlManager.openRepositories.forEach(repository =>
      repository.dispose()
    );
    testUtil.destroyAllTempPaths();
  });

  test("Empty Open Repository", async function () {
    assert.equal(sourceControlManager.repositories.length, 0);
  });

  test("Try Open Repository", async function () {
    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    assert.equal(sourceControlManager.repositories.length, 1);
  });

  test("Try Open Repository Again", async () => {
    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    assert.equal(sourceControlManager.repositories.length, 1);
  });

  test("Try get repository from Uri", () => {
    const repository = sourceControlManager.getRepository(checkoutDir);
    assert.ok(repository);
  });

  test("Try get repository from string", () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);
  });

  test("Try get repository from repository", () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    const repository2 = sourceControlManager.getRepository(repository);
    assert.ok(repository2);
    assert.equal(repository, repository2);
  });

  test("Quick diff waits for initial status", async () => {
    const newCheckoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );
    const unversionedFile = path.join(newCheckoutDir.fsPath, "startup.txt");
    fs.writeFileSync(unversionedFile, "test");

    const svn = sourceControlManager.svn as any;
    const originalOpen = svn.open.bind(svn);
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>(resolve => {
      releaseStatus = resolve;
    });

    svn.open = async (...args: any[]) => {
      const baseRepository = await originalOpen(...args);
      const originalGetStatus = baseRepository.getStatus.bind(baseRepository);
      baseRepository.getStatus = async (...statusArgs: any[]) => {
        await statusGate;
        return originalGetStatus(...statusArgs);
      };
      return baseRepository;
    };

    try {
      await sourceControlManager.tryOpenRepository(newCheckoutDir.fsPath);
      const repository = sourceControlManager.getRepository(newCheckoutDir);
      assert.ok(repository);
      assert.equal(repository.sourceControl.quickDiffProvider, undefined);

      const originalInfo = repository.info.bind(repository);
      let infoCalls = 0;
      (repository as any).info = async (...args: any[]) => {
        infoCalls += 1;
        return originalInfo.apply(repository, args as [string]);
      };

      const repositoryFromUri = await sourceControlManager.getRepositoryFromUri(
        Uri.file(unversionedFile)
      );
      assert.equal(repositoryFromUri, repository);
      assert.equal(infoCalls, 0);
      (repository as any).info = originalInfo;

      const statusChanged = new Promise<void>(resolve => {
        const disposable = repository.onDidChangeStatus(() => {
          disposable.dispose();
          resolve();
        });
      });

      releaseStatus();
      await statusChanged;

      assert.equal(repository.sourceControl.quickDiffProvider, repository);
      assert.equal(
        repository.provideOriginalResource(Uri.file(unversionedFile)),
        undefined
      );
    } finally {
      svn.open = originalOpen;
    }
  });

  test("Try get current branch name", async () => {
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    const name = await repository.getCurrentBranch();
    assert.equal(name, "trunk");
  });

  test("No quick diff for unversioned file", async () => {
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    const file = path.join(checkoutDir.fsPath, "unversioned.txt");
    fs.writeFileSync(file, "test");

    try {
      await repository.status();
      const repositoryFromUri = await sourceControlManager.getRepositoryFromUri(
        Uri.file(file)
      );
      assert.equal(repositoryFromUri, repository);
      assert.equal(
        repository.provideOriginalResource(Uri.file(file)),
        undefined
      );
    } finally {
      fs.unlinkSync(file);
      await repository.status();
    }
  });

  test("File history skips info for unversioned file", async () => {
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    const file = path.join(checkoutDir.fsPath, "unversioned-history.txt");
    fs.writeFileSync(file, "test");
    await repository.status();

    const originalGetInfo = repository.getInfo;
    let getInfoCalls = 0;
    (repository as any).getInfo = async (
      filePath: string,
      revision?: string
    ) => {
      getInfoCalls += 1;
      return originalGetInfo.call(repository, filePath, revision);
    };

    const itemLogProvider = Object.create(
      ItemLogProvider.prototype
    ) as ItemLogProvider;
    const changeEmitter = new EventEmitter<any>();
    (itemLogProvider as any).sourceControlManager = sourceControlManager;
    (itemLogProvider as any)._onDidChangeTreeData = changeEmitter;

    try {
      await itemLogProvider.refresh(undefined, {
        document: { uri: Uri.file(file) }
      } as any);
      assert.equal(getInfoCalls, 0);
    } finally {
      (repository as any).getInfo = originalGetInfo;
      changeEmitter.dispose();
      fs.unlinkSync(file);
      await repository.status();
    }
  });

  test("Try commit file", async function () {
    this.timeout(60000);
    const repository: Repository | null = sourceControlManager.getRepository(
      checkoutDir.fsPath
    );
    if (!repository) {
      return;
    }

    assert.equal(repository.changes.resourceStates.length, 0);

    const file = path.join(checkoutDir.fsPath, "new.txt");

    fs.writeFileSync(file, "test");

    const document = await workspace.openTextDocument(file);
    await window.showTextDocument(document);

    await repository.addFiles([file]);

    assert.equal(repository.changes.resourceStates.length, 1);

    const svnRepository = repository.repository;
    const originalUpdateInfo = svnRepository.updateInfo.bind(svnRepository);
    let updateInfoCalls = 0;
    svnRepository.updateInfo = async () => {
      updateInfoCalls += 1;
      return originalUpdateInfo();
    };

    let repositoryChangeEvents = 0;
    const repositoryChangeListener = sourceControlManager.onDidChangeRepository(
      event => {
        if (event.repository === repository) {
          repositoryChangeEvents += 1;
        }
      }
    );

    try {
      const message = await repository.commitFiles("First Commit", [file]);
      assert.ok(/1 file commited: revision (.*)\./i.test(message));

      assert.equal(repository.changes.resourceStates.length, 0);
      assert.equal(updateInfoCalls, 0);
      assert.equal(repositoryChangeEvents, 1);

      const remoteContent = await repository.show(file, "HEAD");
      assert.equal(remoteContent, "test");
    } finally {
      svnRepository.updateInfo = originalUpdateInfo;
      repositoryChangeListener.dispose();
    }
  });

  test("Try switch branch", async function () {
    this.timeout(60000);
    const newCheckoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    await sourceControlManager.tryOpenRepository(newCheckoutDir.fsPath);
    const newRepository: Repository | null = sourceControlManager.getRepository(
      newCheckoutDir.fsPath
    );
    if (!newRepository) {
      return;
    }
    assert.ok(newRepository);

    await newRepository.newBranch("branches/test");
    const currentBranch = await newRepository.getCurrentBranch();
    assert.equal(currentBranch, "branches/test");
  });
});
