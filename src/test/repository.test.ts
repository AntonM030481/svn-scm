import * as assert from "assert";
import * as fs from "original-fs";
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
      assert.equal(repository.provideOriginalResource(Uri.file(file)), undefined);
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
    (repository as any).getInfo = async (...args: any[]) => {
      getInfoCalls += 1;
      return originalGetInfo.apply(repository, args);
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

    const message = await repository.commitFiles("First Commit", [file]);
    assert.ok(/1 file commited: revision (.*)\./i.test(message));

    assert.equal(repository.changes.resourceStates.length, 0);

    const remoteContent = await repository.show(file, "HEAD");
    assert.equal(remoteContent, "test");
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
