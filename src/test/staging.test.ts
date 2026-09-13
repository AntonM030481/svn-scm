import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, Uri } from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { createStagingChangelist } from "../stagingModel";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): string {
  return cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

suite("Staging Tests", () => {
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

  async function createCheckoutWithFiles(): Promise<Uri> {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    fs.mkdirSync(path.join(checkout.fsPath, "one"));
    fs.mkdirSync(path.join(checkout.fsPath, "two"));
    fs.writeFileSync(path.join(checkout.fsPath, "one", "a.txt"), "a0\n");
    fs.writeFileSync(path.join(checkout.fsPath, "two", "b.txt"), "b0\n");
    svn(["add", "one", "two"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    return checkout;
  }

  test("unstage restores a pre-existing user changelist", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "one", "a.txt");
    fs.writeFileSync(file, "a1\n");
    await repository.status();
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    await repository.addChangelist([file], "personal-work");
    const userResource = repository.changelists
      .get("personal-work")
      ?.resourceStates.find(item => item.resourceUri.fsPath === file);
    assert.ok(userResource);

    await commands.executeCommand("svn.stage", userResource);
    assert.ok(
      repository.changelists.has(createStagingChangelist("personal-work"))
    );
    assert.equal(repository.getResourceFromFile(Uri.file(file))?.resourceUri.fsPath, file);
    assert.equal(repository.staged?.repository, repository);
    assert.equal(sourceControlManager.getRepository(repository.staged), repository);

    await commands.executeCommand("svn.unstage", userResource);
    assert.equal(
      repository.changelists
        .get("personal-work")
        ?.resourceStates.some(item => item.resourceUri.fsPath === file),
      true
    );
  });

  test("one staged commit spans sibling workspace folders in the same WC", async () => {
    const checkout = await createCheckoutWithFiles();
    const one = path.join(checkout.fsPath, "one");
    const two = path.join(checkout.fsPath, "two");

    await sourceControlManager.tryOpenRepository(one);
    await sourceControlManager.tryOpenRepository(two);

    const repositoryOne = sourceControlManager.getRepository(
      Uri.file(path.join(one, "a.txt"))
    ) as Repository;
    const repositoryTwo = sourceControlManager.getRepository(
      Uri.file(path.join(two, "b.txt"))
    ) as Repository;
    opened.push(repositoryOne, repositoryTwo);

    assert.notStrictEqual(repositoryOne, repositoryTwo);
    assert.equal(
      path.resolve(repositoryOne.root),
      path.resolve(repositoryTwo.root)
    );

    const fileOne = path.join(one, "a.txt");
    const fileTwo = path.join(two, "b.txt");
    fs.writeFileSync(fileOne, "a1\n");
    fs.writeFileSync(fileTwo, "b1\n");
    await repositoryOne.status();
    await repositoryTwo.status();

    const resourceOne = repositoryOne.changes.resourceStates.find(
      item => item.resourceUri.fsPath === fileOne
    );
    const resourceTwo = repositoryTwo.changes.resourceStates.find(
      item => item.resourceUri.fsPath === fileTwo
    );
    assert.ok(resourceOne);
    assert.ok(resourceTwo);

    await commands.executeCommand("svn.stage", resourceOne);
    await commands.executeCommand("svn.stage", resourceTwo);

    repositoryOne.inputBox.value = "shared staged commit";
    await commands.executeCommand(
      "svn.commitStaged",
      repositoryOne.sourceControl
    );

    assert.equal(svn(["status"], checkout.fsPath).trim(), "");
    const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
    assert.match(log, /one[\\/]a\.txt/);
    assert.match(log, /two[\\/]b\.txt/);
  });
});
