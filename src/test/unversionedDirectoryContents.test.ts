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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for unversioned directory projection");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

suite("Unversioned Directory Contents Tests", () => {
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
    return testUtil.createRepoCheckout(`${testUtil.getSvnUrl(repoUri)}/trunk`);
  }

  test("shows unversioned descendants and stages one file only", async () => {
    const checkout = await createCheckout();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(checkout) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "new-folder");
    const nested = path.join(directory, "nested");
    const selectedFile = path.join(nested, "selected.txt");
    const otherFile = path.join(directory, "other.txt");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(selectedFile, "selected\n");
    fs.writeFileSync(otherFile, "other\n");

    await repository.status();
    await waitFor(() =>
      repository.unversioned.resourceStates.some(
        resource => resource.resourceUri.fsPath === selectedFile
      )
    );

    const rootResource = repository.unversioned.resourceStates.find(
      resource => resource.resourceUri.fsPath === directory
    );
    const selectedResource = repository.unversioned.resourceStates.find(
      resource => resource.resourceUri.fsPath === selectedFile
    );
    const otherResource = repository.unversioned.resourceStates.find(
      resource => resource.resourceUri.fsPath === otherFile
    );
    assert.ok(rootResource);
    assert.ok(selectedResource);
    assert.ok(otherResource);

    await commands.executeCommand("svn.stage", selectedResource);

    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^A\s+new-folder$/m);
    assert.match(status, /^A\s+new-folder[\\/]nested$/m);
    assert.match(status, /^A\s+new-folder[\\/]nested[\\/]selected\.txt$/m);
    assert.match(status, /^\?\s+new-folder[\\/]other\.txt$/m);
    assert.equal(
      repository.staged?.resourceStates.some(
        resource => resource.resourceUri.fsPath === selectedFile
      ),
      true
    );
    assert.equal(
      repository.staged?.resourceStates.some(
        resource => resource.resourceUri.fsPath === otherFile
      ),
      false
    );
  });
});
