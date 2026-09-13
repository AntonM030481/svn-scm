import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "path";
import {
  commands,
  ConfigurationTarget,
  EventEmitter,
  Uri,
  window,
  workspace
} from "vscode";
import { Status, Operation } from "../common/types";
import { configuration } from "../helpers/configuration";
import { ItemLogProvider } from "../historyView/itemLogProvider";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import { normalizePath } from "../util";
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

      const originalInfo = repository.getInfo.bind(repository);
      let infoCalls = 0;
      (repository as any).getInfo = async (...args: any[]) => {
        infoCalls += 1;
        return originalInfo.apply(repository, args as [string]);
      };

      const repositoryFromUri = await sourceControlManager.getRepositoryFromUri(
        Uri.file(unversionedFile)
      );
      assert.equal(repositoryFromUri, repository);
      assert.equal(infoCalls, 0);
      (repository as any).getInfo = originalInfo;

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
      assert.equal(repositoryFromUri, null);
      assert.equal(
        repository.provideOriginalResource(Uri.file(file)),
        undefined
      );
    } finally {
      fs.unlinkSync(file);
      await repository.status();
    }
  });

  for (const omittedBy of [
    "files.exclude",
    "svn.sourceControl.ignore",
    "not-refreshed"
  ]) {
    test(`Validated routing rejects unversioned paths omitted by ${omittedBy}`, async () => {
      const repository = sourceControlManager.getRepository(checkoutDir);
      assert.ok(repository);
      await repository.initialStatusSettled;
      const name = "routing-hidden.txt";
      const uri = Uri.file(path.join(checkoutDir.fsPath, name));
      const config = workspace.getConfiguration();
      const previous =
        omittedBy === "not-refreshed"
          ? undefined
          : config.inspect(omittedBy)?.globalValue;
      const originalInfo = repository.getInfo;
      let infoCalls = 0;
      repository.getInfo = async target => {
        infoCalls += 1;
        return originalInfo.call(repository, target);
      };
      try {
        if (omittedBy !== "not-refreshed") {
          await config.update(
            omittedBy,
            omittedBy === "files.exclude" ? { [name]: true } : [name],
            ConfigurationTarget.Global
          );
        }
        fs.writeFileSync(uri.fsPath, "unversioned");
        if (omittedBy !== "not-refreshed") {
          await repository.status();
        }
        assert.strictEqual(repository.getResourceFromFile(uri), undefined);
        assert.strictEqual(
          await sourceControlManager.getRepositoryFromUri(uri),
          null
        );
        assert.strictEqual(infoCalls, 1);
      } finally {
        repository.getInfo = originalInfo;
        fs.rmSync(uri.fsPath, { force: true });
        if (omittedBy !== "not-refreshed") {
          await config.update(omittedBy, previous, ConfigurationTarget.Global);
        }
        await repository.status();
      }
    });
  }

  test("Membership validation bypasses an actual cached info result after external revert", async () => {
    const repository = sourceControlManager.getRepository(checkoutDir);
    assert.ok(repository);
    await repository.initialStatusSettled;
    const config = workspace.getConfiguration("svn");
    const previous = config.inspect("autorefresh")?.globalValue;
    const uri = Uri.file(path.join(checkoutDir.fsPath, "routing-cache.txt"));
    const target = normalizePath(uri.fsPath);
    const base = repository.repository;
    const originalExec = base.exec;
    let infoProcesses = 0;
    let scheduled = false;
    base.exec = async (args, options) => {
      if (args[0] === "info" && args.includes(target)) {
        infoProcesses += 1;
      }
      return originalExec.call(base, args, options);
    };
    try {
      await config.update("autorefresh", false, ConfigurationTarget.Global);
      fs.writeFileSync(uri.fsPath, "external SVN mutation");
      // Execute outside Repository operations, without publishing a new SCM
      // snapshot, exactly as another SVN client would with autorefresh off.
      await sourceControlManager.svn.exec(checkoutDir.fsPath, ["add", target]);
      scheduled = true;
      assert.strictEqual(repository.getResourceFromFile(uri), undefined);
      assert.strictEqual(
        await sourceControlManager.getRepositoryFromUri(uri),
        repository
      );
      assert.strictEqual(infoProcesses, 1);

      await sourceControlManager.svn.exec(checkoutDir.fsPath, [
        "revert",
        target
      ]);
      scheduled = false;
      assert.ok(fs.existsSync(uri.fsPath));
      assert.strictEqual(repository.getResourceFromFile(uri), undefined);
      // Prove the successful lower-level metadata cache is still present.
      assert.ok(await repository.info(target));
      assert.strictEqual(infoProcesses, 1);

      assert.strictEqual(
        await sourceControlManager.getRepositoryFromUri(uri),
        null
      );
      assert.strictEqual(infoProcesses, 2);
    } finally {
      base.exec = originalExec;
      try {
        if (scheduled) {
          await sourceControlManager.svn.exec(checkoutDir.fsPath, [
            "revert",
            target
          ]);
        }
      } finally {
        fs.rmSync(uri.fsPath, { force: true });
        await config.update(
          "autorefresh",
          previous,
          ConfigurationTarget.Global
        );
        await repository.status();
      }
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

  test("File history waits for a later status operation", async () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);

    const file = path.join(checkoutDir.fsPath, "history-after-status.txt");
    fs.writeFileSync(file, "test");
    await repository.addFiles([file]);

    const svnRepository = repository.repository;
    const originalGetStatus = svnRepository.getStatus.bind(svnRepository);
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    const statusGate = new Promise<void>(resolve => {
      releaseStatus = resolve;
    });
    const statusStarted = new Promise<void>(resolve => {
      markStatusStarted = resolve;
    });
    let getInfoCalls = 0;

    svnRepository.getStatus = async (params: any) => {
      markStatusStarted();
      await statusGate;
      return originalGetStatus(params);
    };
    const repositoryForHistory = {
      initialStatusSettled: repository.initialStatusSettled,
      operations: repository.operations,
      onDidRunOperation: repository.onDidRunOperation,
      unversioned: repository.unversioned,
      getInfo: async (filePath: string) => {
        getInfoCalls += 1;
        return repository.getInfo(filePath);
      }
    };

    const itemLogProvider = Object.create(
      ItemLogProvider.prototype
    ) as ItemLogProvider;
    const changeEmitter = new EventEmitter<any>();
    (itemLogProvider as any).sourceControlManager = {
      getRepository: () => repositoryForHistory
    };
    (itemLogProvider as any)._onDidChangeTreeData = changeEmitter;

    const document = await workspace.openTextDocument(file);
    const editor = await window.showTextDocument(document);
    const status = repository.status();

    try {
      await statusStarted;
      const refresh = itemLogProvider.refresh(undefined, editor);
      await Promise.resolve();
      assert.equal(getInfoCalls, 0);

      releaseStatus();
      await status;
      await refresh;

      assert.equal(getInfoCalls, 1);
      assert.ok((itemLogProvider as any).currentItem);
    } finally {
      releaseStatus();
      svnRepository.getStatus = originalGetStatus;
      changeEmitter.dispose();
      await repository.revert([file], "empty");
      fs.unlinkSync(file);
      await repository.status();
      await commands.executeCommand("workbench.action.closeActiveEditor");
    }
  });

  test("External combination setting refreshes cached status", async () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);

    const svnRepository = repository.repository;
    const originalGetStatus = svnRepository.getStatus.bind(svnRepository);
    const originalConfigurationGet = configuration.get.bind(configuration);
    const repositoryUuid = await svnRepository.getRepositoryUuid();
    let combineExternal = false;
    const statusParams: any[] = [];
    const forcedStatusParams: any[] = [];
    let blockNextStatus: Promise<void> | undefined;
    let markBlockedStatusStarted: (() => void) | undefined;

    (configuration as any).get = (section: string, defaultValue?: any) => {
      if (section === "sourceControl.combineExternalIfSameServer") {
        return combineExternal;
      }
      return originalConfigurationGet(section, defaultValue);
    };
    svnRepository.getStatus = async (params: any) => {
      statusParams.push(params);
      if (params.forceFull) {
        forcedStatusParams.push(params);
      }
      if (blockNextStatus) {
        const blocked = blockNextStatus;
        blockNextStatus = undefined;
        markBlockedStatusStarted?.();
        await blocked;
      }
      return [
        {
          path: "cached-external",
          status: Status.EXTERNAL,
          props: Status.NONE,
          wcStatus: { locked: false, switched: false },
          repositoryUuid: params.resolveExternalRepositoryUuid
            ? repositoryUuid
            : undefined
        },
        {
          path: "cached-external/modified.txt",
          status: Status.MODIFIED,
          props: Status.NONE,
          wcStatus: { locked: false, switched: false }
        }
      ];
    };

    const fireSettingChange = async () => {
      const previousForcedCount = forcedStatusParams.length;
      const statusFinished = new Promise<void>(resolve => {
        const listener = repository.onDidRunOperation(operation => {
          if (
            operation === Operation.Status &&
            forcedStatusParams.length > previousForcedCount
          ) {
            listener.dispose();
            resolve();
          }
        });
      });
      (configuration as any)._onDidChange.fire({
        affectsConfiguration: (section: string) =>
          section === "svn.sourceControl.combineExternalIfSameServer"
      });
      await statusFinished;
    };

    try {
      await repository.status();
      assert.equal(statusParams.at(-1).resolveExternalRepositoryUuid, false);
      assert.equal(repository.statusExternal.length, 1);
      assert.equal(repository.changes.resourceStates.length, 0);

      let releaseBlockedStatus!: () => void;
      let blockedStatusStarted!: () => void;
      blockNextStatus = new Promise<void>(resolve => {
        releaseBlockedStatus = resolve;
      });
      const statusStarted = new Promise<void>(resolve => {
        blockedStatusStarted = resolve;
      });
      markBlockedStatusStarted = blockedStatusStarted;

      const activeStatus = repository.status();
      await statusStarted;
      const queuedStatus = repository.status();
      combineExternal = true;
      const previousForcedCount = forcedStatusParams.length;
      const fullStatusFinished = new Promise<void>(resolve => {
        const listener = repository.onDidRunOperation(operation => {
          if (
            operation === Operation.Status &&
            forcedStatusParams.length > previousForcedCount
          ) {
            listener.dispose();
            resolve();
          }
        });
      });
      (configuration as any)._onDidChange.fire({
        affectsConfiguration: (section: string) =>
          section === "svn.sourceControl.combineExternalIfSameServer"
      });
      releaseBlockedStatus();
      await Promise.all([activeStatus, queuedStatus, fullStatusFinished]);

      assert.equal(
        forcedStatusParams.at(-1).resolveExternalRepositoryUuid,
        true
      );
      assert.equal(forcedStatusParams.at(-1).forceFull, true);
      assert.equal(repository.statusExternal.length, 0);
      assert.equal(repository.changes.resourceStates.length, 1);

      combineExternal = false;
      await fireSettingChange();
      assert.equal(
        forcedStatusParams.at(-1).resolveExternalRepositoryUuid,
        false
      );
      assert.equal(forcedStatusParams.at(-1).forceFull, true);
      assert.equal(repository.statusExternal.length, 1);
      assert.equal(repository.changes.resourceStates.length, 0);
    } finally {
      svnRepository.getStatus = originalGetStatus;
      (configuration as any).get = originalConfigurationGet;
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
