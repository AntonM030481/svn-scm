import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, SourceControlResourceState, Uri } from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): string {
  return cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

suite("Staging UI Argument Tests", () => {
  let sourceControlManager: SourceControlManager;
  const opened: Repository[] = [];

  suiteSetup(async () => {
    await testUtil.activeExtension();
    sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;
  });

  suiteTeardown(() => {
    opened.forEach(repository => sourceControlManager.close(repository));
  });

  test("Stage and Unstage accept SCM resource-state-shaped arguments", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const file = path.join(checkout.fsPath, "file.txt");
    fs.writeFileSync(file, "base\n");
    svn(["add", "file.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(file, "changed\n");
    await repository.status();
    assert.ok(
      repository.changes.resourceStates.some(
        resource => resource.resourceUri.fsPath === file
      )
    );

    // Match the structural contract VS Code SCM menu actions may forward. This
    // deliberately is not an instance of our Resource class.
    const uiResource = {
      resourceUri: Uri.file(file)
    } as SourceControlResourceState;

    await commands.executeCommand("svn.stage", uiResource);
    assert.equal(
      repository.staged?.resourceStates.some(
        resource => resource.resourceUri.fsPath === file
      ),
      true
    );

    await commands.executeCommand("svn.unstage", uiResource);
    assert.equal(
      repository.staged?.resourceStates.some(
        resource => resource.resourceUri.fsPath === file
      ),
      false
    );
    assert.equal(
      repository.changes.resourceStates.some(
        resource => resource.resourceUri.fsPath === file
      ),
      true
    );
  });
});
