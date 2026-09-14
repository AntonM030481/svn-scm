import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands } from "vscode";
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

  test("Stage and Unstage accept SCM tree resource-node arguments", async () => {
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
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    // SCM tree view uses an IResourceNode wrapper as the inline action context.
    // The actual SourceControlResourceState is stored in `element`.
    const treeResourceNode = { element: resource };
    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", treeResourceNode);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );

    const stagedResource = repository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(stagedResource);
    await commands.executeCommand("svn.unstage", {
      element: stagedResource
    });
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      false
    );
    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
    assert.equal(fullStatusCalls, 0);
  });

  test("Stage accepts an unversioned SCM tree resource-node argument", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "new.txt");
    fs.writeFileSync(file, "new\n");
    await repository.status();
    const resource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    await commands.executeCommand("svn.stage", { element: resource });

    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
    assert.match(svn(["status"], checkout.fsPath), /^A\s+new\.txt$/m);
    assert.match(
      svn(["status", "--xml"], checkout.fsPath),
      /__svn_scm_staged__/
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
    svn(
      ["commit", "-m", "remote change", "conflicted.txt"],
      peerCheckout.fsPath
    );
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
