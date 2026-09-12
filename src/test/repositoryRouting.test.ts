import * as assert from "assert";
import { commands, Uri } from "vscode";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

suite("Repository Routing", () => {
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

  test("routes a clean working-copy path without svn info", async () => {
    const repository = sourceControlManager.getRepository(checkoutDir.fsPath);
    assert.ok(repository);
    await repository.initialStatusSettled;

    const originalInfo = repository.info.bind(repository);
    let infoCalls = 0;
    repository.info = async (...args: Parameters<typeof originalInfo>) => {
      infoCalls += 1;
      return originalInfo(...args);
    };

    try {
      const resolved = await sourceControlManager.getRepositoryFromUri(
        checkoutDir
      );
      assert.equal(resolved, repository);
      assert.equal(infoCalls, 0);
    } finally {
      repository.info = originalInfo;
    }
  });
});
