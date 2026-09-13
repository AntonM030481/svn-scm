import * as assert from "assert";
import { commands, Uri } from "vscode";
import { Operation } from "../common/types";
import { configuration } from "../helpers/configuration";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

suite("Repository Lifecycle", () => {
  let checkoutDir: Uri;
  let sourceControlManager: SourceControlManager;

  suiteSetup(async () => {
    await testUtil.activeExtension();

    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    checkoutDir = await testUtil.createRepoCheckout(
      testUtil.getSvnUrl(repoUri) + "/trunk"
    );

    sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      checkoutDir
    )) as SourceControlManager;
    await sourceControlManager.tryOpenRepository(checkoutDir.fsPath);
  });

  suiteTeardown(() => {
    sourceControlManager.openRepositories.forEach(repository =>
      repository.dispose()
    );
    testUtil.destroyAllTempPaths();
  });

  test("dispose cancels deferred refresh and configuration listener", async () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);

    let createIntervalCalls = 0;
    let updateRemoteCalls = 0;
    (repository as any).createRemoteChangedInterval = () => {
      createIntervalCalls += 1;
    };
    (repository as any).updateRemoteChangedFiles = () => {
      updateRemoteCalls += 1;
    };

    let runCalls = 0;
    (repository as any).run = () => {
      runCalls += 1;
      return Promise.resolve();
    };
    (repository as any)._operations.start(Operation.Status);
    const deferredFullStatus = repository.fullStatus();
    const deferredWatcherStatus = (repository as any).updateWhenIdleAndWait();
    await Promise.resolve();

    repository.dispose();
    (repository as any)._operations.end(Operation.Status);
    (repository as any)._onDidRunOperation.fire(Operation.Status);
    await deferredFullStatus;
    await deferredWatcherStatus;

    (configuration as any)._onDidChange.fire({
      affectsConfiguration: (section: string) =>
        section === "svn.remoteChanges.checkFrequency"
    });

    assert.equal(createIntervalCalls, 0);
    assert.equal(updateRemoteCalls, 0);
    assert.equal(runCalls, 0);
  });
});
