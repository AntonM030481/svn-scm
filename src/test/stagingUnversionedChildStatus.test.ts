import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, Uri } from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { isUnversionedChildResource } from "../unversionedDirectoryContents";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): string {
  return cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

async function waitForChild(
  repository: Repository,
  file: string
): Promise<ReturnType<typeof repository.getResourceFromFile>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const resource = repository.getResourceFromFile(Uri.file(file));
    if (resource && isUnversionedChildResource(resource)) return resource;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return undefined;
}

suite("Staging Unversioned Child Status Tests", () => {
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

  test("staging one child of an unversioned folder avoids full status", async () => {
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

    const directory = path.join(checkout.fsPath, "unversioned-folder");
    const file = path.join(directory, "one.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, "one\n");
    await repository.status();

    const resource = await waitForChild(repository, file);
    assert.ok(resource);
    assert.equal(isUnversionedChildResource(resource), true);

    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", { element: resource });

    assert.equal(fullStatusCalls, 0);
    assert.match(
      svn(["status"], checkout.fsPath),
      /^A\s+unversioned-folder[\\/]one\.txt$/m
    );
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
  });
});
