import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, ConfigurationTarget, Uri, workspace } from "vscode";
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

  test("Delete refreshes every overlapping projection in the same WC", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const nested = path.join(checkout.fsPath, "nested");
    const baseFile = path.join(nested, "base.txt");
    fs.mkdirSync(nested);
    fs.writeFileSync(baseFile, "base\n");
    svn(["add", "nested"], checkout.fsPath);
    svn(["commit", "-m", "nested scope"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(nested);
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const nestedRepository = sourceControlManager.repositories.find(
      repository =>
        path.resolve(repository.workspaceRoot) === path.resolve(nested)
    );
    const rootRepository = sourceControlManager.repositories.find(
      repository =>
        path.resolve(repository.workspaceRoot) === path.resolve(checkout.fsPath)
    );
    assert.ok(nestedRepository);
    assert.ok(rootRepository);
    opened.push(nestedRepository, rootRepository);

    const file = path.join(nested, "delete-me.txt");
    fs.writeFileSync(file, "temporary\n");
    await Promise.all([nestedRepository.status(), rootRepository.status()]);
    const nestedResource = nestedRepository.getResourceFromFile(Uri.file(file));
    assert.ok(nestedResource);
    assert.ok(rootRepository.getResourceFromFile(Uri.file(file)));

    const config = workspace.getConfiguration("svn");
    const previousAutorefresh =
      config.inspect<boolean>("autorefresh")?.globalValue;
    try {
      await config.update("autorefresh", false, ConfigurationTarget.Global);
      await commands.executeCommand("svn.deleteUnversioned", nestedResource);

      assert.equal(fs.existsSync(file), false);
      assert.equal(
        nestedRepository.getResourceFromFile(Uri.file(file)),
        undefined
      );
      assert.equal(
        rootRepository.getResourceFromFile(Uri.file(file)),
        undefined
      );
    } finally {
      await config.update(
        "autorefresh",
        previousAutorefresh,
        ConfigurationTarget.Global
      );
    }
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
