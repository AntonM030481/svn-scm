import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, Uri } from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { normalizePath } from "../util";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): string {
  return cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

suite("Staging Live Validation Tests", () => {
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

  async function createCheckout(): Promise<Uri> {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    fs.mkdirSync(path.join(checkout.fsPath, "one"));
    fs.writeFileSync(path.join(checkout.fsPath, "one", "a.txt"), "a0\n");
    fs.writeFileSync(path.join(checkout.fsPath, "one", "b.txt"), "b0\n");
    svn(["add", "one"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    return checkout;
  }

  test("stale unversioned metadata cannot revert a versioned edit", async () => {
    const checkout = await createCheckout();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "new.txt");
    fs.writeFileSync(file, "new\n");
    await repository.status();
    const unversioned = repository.unversioned.resourceStates.find(
      resource => resource.resourceUri.fsPath === file
    );
    assert.ok(unversioned);

    await commands.executeCommand("svn.stage", unversioned);
    const stagingChangelist = repository.stagedChangelists.get(
      normalizePath(file)
    );
    assert.ok(stagingChangelist);

    // SVN versions may clear changelists on commit, so explicitly recreate the
    // dangerous state: a versioned modified file carrying stale :u metadata.
    svn(["commit", "-m", "external add", "new.txt"], checkout.fsPath);
    fs.writeFileSync(file, "external edit\n");
    svn(["changelist", stagingChangelist, "new.txt"], checkout.fsPath);
    await repository.fullStatus();

    const staleMetadataStaged = repository.staged?.resourceStates.find(
      resource => resource.resourceUri.fsPath === file
    );
    assert.ok(staleMetadataStaged);

    await commands.executeCommand("svn.unstage", staleMetadataStaged);

    assert.equal(fs.readFileSync(file, "utf8"), "external edit\n");
    assert.match(svn(["status"], checkout.fsPath), /^M\s+new\.txt$/m);
    assert.doesNotMatch(
      svn(["status", "--xml"], checkout.fsPath),
      /__svn_scm_staged__/
    );
  });

  test("commit staged rebuilds selection after live status", async () => {
    const checkout = await createCheckout();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const staleFile = path.join(checkout.fsPath, "one", "a.txt");
    const stagedFile = path.join(checkout.fsPath, "one", "b.txt");
    fs.writeFileSync(staleFile, "a1\n");
    fs.writeFileSync(stagedFile, "b1\n");
    await repository.status();
    const staleChanged = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === staleFile
    );
    const stagedChanged = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === stagedFile
    );
    assert.ok(staleChanged);
    assert.ok(stagedChanged);

    await commands.executeCommand("svn.stage", staleChanged);
    await commands.executeCommand("svn.stage", stagedChanged);
    assert.equal(repository.staged?.resourceStates.length, 2);

    svn(["changelist", "--remove", path.join("one", "a.txt")], checkout.fsPath);
    fs.writeFileSync(staleFile, "external edit\n");

    repository.inputBox.value = "commit only still-staged file";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);

    assert.equal(fs.readFileSync(staleFile, "utf8"), "external edit\n");
    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^M\s+one[\\/]a\.txt$/m);
    assert.doesNotMatch(status, /one[\\/]b\.txt/);
    const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
    assert.match(log, /one[\\/]b\.txt/);
    assert.doesNotMatch(log, /one[\\/]a\.txt/);
  });
});
