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

suite("Staged Commit Status Tests", () => {
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
    fs.writeFileSync(path.join(checkout.fsPath, "tracked.txt"), "before\n");
    svn(["add", "tracked.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    return checkout;
  }

  test("committing a known staged file uses only targeted status", async () => {
    const checkout = await createCheckout();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(checkout) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "tracked.txt");
    fs.writeFileSync(file, "after\n");
    await repository.status();
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);
    await commands.executeCommand("svn.stage", resource);

    const lowLevelRepository = repository.repository as any;
    const originalExec = lowLevelRepository.exec.bind(lowLevelRepository);
    let fullLocalStatusCalls = 0;
    lowLevelRepository.exec = async (args: string[], options?: unknown) => {
      if (
        args.length === 4 &&
        args[0] === "stat" &&
        args[1] === "--xml" &&
        args[2] === "--no-ignore" &&
        args[3] === "--ignore-externals"
      ) {
        fullLocalStatusCalls++;
      }
      return originalExec(args, options);
    };

    try {
      repository.inputBox.value = "targeted staged commit";
      await commands.executeCommand("svn.commitStaged", repository.sourceControl);
    } finally {
      lowLevelRepository.exec = originalExec;
    }

    assert.equal(fullLocalStatusCalls, 0);
    assert.equal(svn(["status"], checkout.fsPath).trim(), "");
  });
});
