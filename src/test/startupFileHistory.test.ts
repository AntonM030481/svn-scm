import * as assert from "assert";
import * as fs from "original-fs";
import * as path from "path";
import {
  commands,
  EventEmitter,
  TextEditor,
  Uri,
  window,
  workspace
} from "vscode";
import { ItemLogProvider } from "../historyView/itemLogProvider";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

suite("Startup File History Tests", () => {
  let repoUri: Uri;
  let sourceControlManager: SourceControlManager;
  const versionedFileName = "versioned-startup.txt";

  suiteSetup(async () => {
    await testUtil.activeExtension();

    repoUri = await testUtil.createRepoServer();
    const repoUrl = testUtil.getSvnUrl(repoUri);
    await testUtil.createStandardLayout(repoUrl);

    const importDir = testUtil.newTempDir("svn_startup_import_");
    const importFile = path.join(importDir, versionedFileName);
    fs.writeFileSync(importFile, "versioned");
    await testUtil.importToRepoServer(
      `${repoUrl}/trunk/${versionedFileName}`,
      importFile,
      "Add startup history fixture"
    );

    sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      repoUri
    )) as SourceControlManager;
  });

  suiteTeardown(() => {
    sourceControlManager.openRepositories
      .slice()
      .forEach(repository => repository.dispose());
    testUtil.destroyAllTempPaths();
  });

  async function openWithBlockedInitialStatus(
    fileName: string,
    createUnversioned: boolean
  ): Promise<{
    repository: Repository;
    editor: TextEditor;
    releaseStatus: () => void;
    restoreSvnOpen: () => void;
  }> {
    const checkoutDir = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const file = path.join(checkoutDir.fsPath, fileName);

    if (createUnversioned) {
      fs.writeFileSync(file, "unversioned");
    }

    const document = await workspace.openTextDocument(file);
    const editor = await window.showTextDocument(document);

    const svn = sourceControlManager.svn as any;
    const originalOpen = svn.open.bind(svn);
    let releaseStatus!: () => void;
    // Keep the initial scan pending while the active editor asks for history.
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

    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
    const repository = sourceControlManager.getRepository(checkoutDir);
    assert.ok(repository);
    assert.equal(repository.isInitialStatusPending, true);

    return {
      repository,
      editor,
      releaseStatus,
      restoreSvnOpen: () => {
        svn.open = originalOpen;
      }
    };
  }

  function createItemLogProvider(): {
    provider: ItemLogProvider;
    emitter: EventEmitter<any>;
  } {
    const provider = Object.create(
      ItemLogProvider.prototype
    ) as ItemLogProvider;
    const emitter = new EventEmitter<any>();
    (provider as any).sourceControlManager = sourceControlManager;
    (provider as any)._onDidChangeTreeData = emitter;
    return { provider, emitter };
  }

  test("Versioned active file waits for initial status", async () => {
    const started = Date.now();
    const startup = await openWithBlockedInitialStatus(
      versionedFileName,
      false
    );
    const { repository, editor } = startup;
    const originalGetInfo = repository.getInfo;
    let getInfoCalls = 0;
    (repository as any).getInfo = async (
      filePath: string,
      revision?: string
    ) => {
      getInfoCalls += 1;
      return originalGetInfo.call(repository, filePath, revision);
    };

    const { provider, emitter } = createItemLogProvider();

    try {
      const refresh = provider.refresh(undefined, editor);
      await Promise.resolve();
      assert.equal(getInfoCalls, 0);

      startup.releaseStatus();
      await refresh;

      assert.equal(repository.isInitialStatusPending, false);
      assert.equal(getInfoCalls, 1);
      assert.ok((provider as any).currentItem);
    } finally {
      startup.releaseStatus();
      (repository as any).getInfo = originalGetInfo;
      emitter.dispose();
      startup.restoreSvnOpen();
      sourceControlManager.close(repository);
      await commands.executeCommand("workbench.action.closeActiveEditor");
    }

    console.log(`[startup-file-history] versioned: ${Date.now() - started} ms`);
  });

  test("Unversioned active file waits for initial status without svn info", async () => {
    const started = Date.now();
    const fileName = "unversioned-startup.txt";
    const startup = await openWithBlockedInitialStatus(fileName, true);
    const { repository, editor } = startup;
    const originalGetInfo = repository.getInfo;
    let getInfoCalls = 0;
    (repository as any).getInfo = async (
      filePath: string,
      revision?: string
    ) => {
      getInfoCalls += 1;
      return originalGetInfo.call(repository, filePath, revision);
    };

    const { provider, emitter } = createItemLogProvider();

    try {
      const refresh = provider.refresh(undefined, editor);
      await Promise.resolve();
      assert.equal(getInfoCalls, 0);

      startup.releaseStatus();
      await refresh;

      assert.equal(repository.isInitialStatusPending, false);
      assert.equal(getInfoCalls, 0);
      assert.equal((provider as any).currentItem, undefined);
      assert.equal(
        repository.provideOriginalResource(editor.document.uri),
        undefined
      );
    } finally {
      startup.releaseStatus();
      (repository as any).getInfo = originalGetInfo;
      emitter.dispose();
      startup.restoreSvnOpen();
      sourceControlManager.close(repository);
      await commands.executeCommand("workbench.action.closeActiveEditor");
    }

    console.log(
      `[startup-file-history] unversioned: ${Date.now() - started} ms`
    );
  });
});
