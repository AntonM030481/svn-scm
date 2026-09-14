import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, Uri } from "vscode";
import { Operation } from "../common/types";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): void {
  cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

suite("Shared working-copy staging guard", () => {
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

  test("Stage waits for a busy sibling projection in the same WC", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const one = path.join(checkout.fsPath, "one");
    const two = path.join(checkout.fsPath, "two");
    fs.mkdirSync(one);
    fs.mkdirSync(two);
    const fileOne = path.join(one, "a.txt");
    const fileTwo = path.join(two, "b.txt");
    fs.writeFileSync(fileOne, "a0\n");
    fs.writeFileSync(fileTwo, "b0\n");
    svn(["add", "one", "two"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(one);
    await sourceControlManager.tryOpenRepository(two);
    const repositoryOne = sourceControlManager.getRepository(
      Uri.file(fileOne)
    ) as Repository;
    const repositoryTwo = sourceControlManager.getRepository(
      Uri.file(fileTwo)
    ) as Repository;
    opened.push(repositoryOne, repositoryTwo);

    assert.notStrictEqual(repositoryOne, repositoryTwo);
    assert.equal(
      path.resolve(repositoryOne.root),
      path.resolve(repositoryTwo.root)
    );

    fs.writeFileSync(fileOne, "a1\n");
    await repositoryOne.fullStatus();
    const resource = repositoryOne.changes.resourceStates.find(
      item => item.resourceUri.fsPath === fileOne
    );
    assert.ok(resource);

    const originalWhenIdle = repositoryTwo.whenIdle.bind(repositoryTwo);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    (repositoryTwo as any).whenIdle = async () => {
      entered();
      await blocked;
      return true;
    };

    try {
      const stage = commands.executeCommand("svn.stage", resource);
      await enteredPromise;
      assert.equal(
        repositoryOne.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === fileOne
        ),
        false
      );

      let updateStarted = false;
      const updateStartedDisposable = repositoryTwo.onRunOperation(
        operation => {
          if (operation === Operation.Update) {
            updateStarted = true;
            assert.equal(
              repositoryOne.staged?.resourceStates.some(
                item => item.resourceUri.fsPath === fileOne
              ),
              true
            );
          }
        }
      );
      const update = repositoryTwo.updateRevision();
      assert.equal(updateStarted, false);

      release();
      await stage;
      await update;
      updateStartedDisposable.dispose();
      assert.equal(updateStarted, true);
      assert.equal(
        repositoryOne.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === fileOne
        ),
        true
      );
    } finally {
      release();
      (repositoryTwo as any).whenIdle = originalWhenIdle;
    }
  });
});
