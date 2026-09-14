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

suite("Unversioned Folder Unstage Tests", () => {
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

  test("unstage immediately returns a staging-created folder to Unversioned", async () => {
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

    const directory = path.join(checkout.fsPath, "unstage-folder");
    const child = path.join(directory, "child.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(child, "child\n");
    await repository.status();

    const folder = repository.unversioned.resourceStates.find(
      resource => resource.resourceUri.fsPath === directory
    );
    assert.ok(folder);

    await commands.executeCommand("svn.stage", folder);
    assert.equal(
      repository.changes.resourceStates.some(
        resource => resource.resourceUri.fsPath === directory
      ),
      true
    );
    assert.ok(repository.staged?.resourceStates.length);

    await commands.executeCommand("svn.unstageAll", repository.staged);

    assert.equal(
      repository.changes.resourceStates.some(
        resource => resource.resourceUri.fsPath === directory
      ),
      false
    );
    assert.equal(
      repository.unversioned.resourceStates.some(
        resource => resource.resourceUri.fsPath === directory
      ),
      true
    );
    assert.match(svn(["status"], checkout.fsPath), /^\?\s+unstage-folder$/m);
  });
});
