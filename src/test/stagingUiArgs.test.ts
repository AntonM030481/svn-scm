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

  test("Commit Staged skips conflicted staged files", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const trunkUrl = `${testUtil.getSvnUrl(repoUri)}/trunk`;
    const checkout = await testUtil.createRepoCheckout(trunkUrl);
    const peerCheckout = await testUtil.createRepoCheckout(trunkUrl);
    const conflictedFile = path.join(checkout.fsPath, "conflicted.txt");
    const cleanFile = path.join(checkout.fsPath, "clean.txt");

    fs.writeFileSync(conflictedFile, "base\n");
    fs.writeFileSync(cleanFile, "base\n");
    svn(["add", "conflicted.txt", "clean.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    svn(["update"], peerCheckout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(conflictedFile, "local\n");
    fs.writeFileSync(cleanFile, "clean local\n");
    await repository.status();

    const conflictedResource = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === conflictedFile
    );
    const cleanResource = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === cleanFile
    );
    assert.ok(conflictedResource);
    assert.ok(cleanResource);

    await commands.executeCommand("svn.stage", conflictedResource);
    await commands.executeCommand("svn.stage", cleanResource);

    fs.writeFileSync(
      path.join(peerCheckout.fsPath, "conflicted.txt"),
      "remote\n"
    );
    svn(["commit", "-m", "remote change", "conflicted.txt"], peerCheckout.fsPath);
    svn(["update"], checkout.fsPath);
    await repository.fullStatus();

    assert.equal(
      repository.conflicts.resourceStates.some(
        resource => resource.resourceUri.fsPath === conflictedFile
      ),
      true
    );

    repository.inputBox.value = "commit clean staged file";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);

    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^C\s+conflicted\.txt$/m);
    assert.doesNotMatch(status, /^M\s+clean\.txt$/m);
    const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
    assert.match(log, /clean\.txt/);
    assert.doesNotMatch(log, /conflicted\.txt/);
  });
});
