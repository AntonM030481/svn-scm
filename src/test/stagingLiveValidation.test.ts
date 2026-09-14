import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, Uri } from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
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
    svn(["add", "one"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    return checkout;
  }

  test("stale unstage selection is re-resolved after live status", async () => {
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
    const staleStaged = repository.staged?.resourceStates.find(
      resource => resource.resourceUri.fsPath === file
    );
    assert.ok(staleStaged);

    svn(["changelist", "--remove", "new.txt"], checkout.fsPath);
    svn(["commit", "-m", "external add", "new.txt"], checkout.fsPath);
    fs.writeFileSync(file, "external edit\n");

    const originalEnsureStatus = repository.ensureStatus.bind(repository);
    (repository as any).ensureStatus = async () => {
      await repository.status();
    };
    try {
      await commands.executeCommand("svn.unstage", staleStaged);
    } finally {
      (repository as any).ensureStatus = originalEnsureStatus;
    }

    assert.equal(fs.readFileSync(file, "utf8"), "external edit\n");
    assert.match(svn(["status"], checkout.fsPath), /^M\s+new\.txt$/m);
  });

  test("commit staged rebuilds selection after live status", async () => {
    const checkout = await createCheckout();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "one", "a.txt");
    fs.writeFileSync(file, "a1\n");
    await repository.status();
    const changed = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === file
    );
    assert.ok(changed);

    await commands.executeCommand("svn.stage", changed);
    assert.equal(repository.staged?.resourceStates.length, 1);

    svn(["changelist", "--remove", path.join("one", "a.txt")], checkout.fsPath);
    fs.writeFileSync(file, "external edit\n");

    const originalEnsureStatus = repository.ensureStatus.bind(repository);
    (repository as any).ensureStatus = async () => {
      await repository.status();
    };
    try {
      repository.inputBox.value = "must not commit stale selection";
      await commands.executeCommand(
        "svn.commitStaged",
        repository.sourceControl
      );
    } finally {
      (repository as any).ensureStatus = originalEnsureStatus;
    }

    assert.equal(fs.readFileSync(file, "utf8"), "external edit\n");
    assert.match(svn(["status"], checkout.fsPath), /^M\s+one[\\/]a\.txt$/m);
  });
});
