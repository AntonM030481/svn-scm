import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, ConfigurationTarget, Uri, workspace } from "vscode";
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
    const userGroup = repository.changelists.get("personal-work");
    const userResource = userGroup?.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(userResource);
    assert.equal(repository.unversioned.repository, repository);
    assert.equal(userGroup?.repository, repository);
    assert.equal(sourceControlManager.getRepository(userGroup), repository);

    await commands.executeCommand("svn.stage", userResource);
    assert.ok(
      repository.changelists.has(createStagingChangelist("personal-work"))
    );
    assert.equal(
      repository.getResourceFromFile(Uri.file(file))?.resourceUri.fsPath,
      file
    );
    assert.equal(repository.staged?.repository, repository);
    assert.equal(
      sourceControlManager.getRepository(repository.staged),
      repository
    );

    await commands.executeCommand("svn.unstage", userResource);
    assert.equal(
      repository.changelists
        .get("personal-work")
        ?.resourceStates.some(item => item.resourceUri.fsPath === file),
      true
    );
  });

  test("staged files survive sequential targeted staging operations", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const fileOne = path.join(checkout.fsPath, "one", "a.txt");
    const fileTwo = path.join(checkout.fsPath, "two", "b.txt");
    fs.writeFileSync(fileOne, "a1\n");
    fs.writeFileSync(fileTwo, "b1\n");
    await repository.status();

    const resourceOne = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === fileOne
    );
    const resourceTwo = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === fileTwo
    );
    assert.ok(resourceOne);
    assert.ok(resourceTwo);

    await commands.executeCommand("svn.stage", resourceOne);
    await commands.executeCommand("svn.stage", resourceTwo);

    assert.equal(repository.staged?.resourceStates.length, 2);
    assert.ok(repository.getResourceFromFile(Uri.file(fileOne)));
    assert.ok(repository.getResourceFromFile(Uri.file(fileTwo)));

    repository.inputBox.value = "sequential staged commit";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);
    assert.equal(svn(["status"], checkout.fsPath).trim(), "");

    fs.writeFileSync(fileOne, "a2\n");
    await repository.status();
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === fileOne
      ),
      false
    );
    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === fileOne
      ),
      true
    );
  });

  test("committed unversioned files leave the staging changelist", async () => {
    const checkout = await createCheckoutWithFiles();
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

    await commands.executeCommand("svn.stage", resource);
    repository.inputBox.value = "commit new staged file";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);

    assert.equal(fs.existsSync(file), true);
    assert.equal(svn(["status"], checkout.fsPath).trim(), "");

    fs.writeFileSync(file, "changed after commit\n");
    await repository.status();
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
  });

  test("unstaging an unversioned folder restores its scheduled additions", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "new-folder");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "new.txt"), "new\n");
    await repository.status();

    const resource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === directory
    );
    assert.ok(resource);

    await commands.executeCommand("svn.stage", resource);
    assert.match(svn(["status"], checkout.fsPath), /^A\s+new-folder/m);

    await commands.executeCommand("svn.unstageAll", repository.staged);
    const status = svn(["status"], checkout.fsPath);
    assert.doesNotMatch(status, /^A\s+new-folder/m);
    assert.match(status, /^\?\s+new-folder/m);
  });

  test("staging an unversioned folder leaves files.exclude children unadded", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "filtered-folder");
    const visible = path.join(directory, "visible.txt");
    const hidden = path.join(directory, "hidden.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(visible, "visible\n");
    fs.writeFileSync(hidden, "hidden\n");

    const filesConfiguration = workspace.getConfiguration("files", checkout);
    const previousExclude =
      filesConfiguration.inspect<Record<string, boolean>>(
        "exclude"
      )?.globalValue;
    await filesConfiguration.update(
      "exclude",
      { ...(previousExclude ?? {}), "**/hidden.txt": true },
      ConfigurationTarget.Global
    );

    try {
      await repository.status();
      const resource = repository.unversioned.resourceStates.find(
        item => item.resourceUri.fsPath === directory
      );
      assert.ok(resource);

      await commands.executeCommand("svn.stage", resource);
      const status = svn(["status"], checkout.fsPath);
      assert.match(status, /^A\s+filtered-folder[\\/]visible\.txt/m);
      assert.match(status, /^\?\s+filtered-folder[\\/]hidden\.txt/m);
      assert.doesNotMatch(status, /^A\s+filtered-folder[\\/]hidden\.txt/m);
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === visible
        ),
        true
      );
    } finally {
      await filesConfiguration.update(
        "exclude",
        previousExclude,
        ConfigurationTarget.Global
      );
    }
  });

  test("symlinks targeting directories remain stageable files", async () => {
    if (process.platform === "win32") return;

    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const link = path.join(checkout.fsPath, "dir-link");
    fs.symlinkSync("one", link);
    await repository.status();

    const unversioned = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === link
    );
    assert.ok(unversioned);
    await commands.executeCommand("svn.stage", unversioned);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === link
      ),
      true
    );

    repository.inputBox.value = "add staged symlink";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);
    assert.equal(svn(["status"], checkout.fsPath).trim(), "");

    fs.unlinkSync(link);
    fs.symlinkSync("two", link);
    await repository.status();
    const modified = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === link
    );
    assert.ok(modified);
    await commands.executeCommand("svn.stage", modified);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === link
      ),
      true
    );
  });

  test("directory-only versioned changes stay unstaged", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "one");
    svn(["propset", "stage-test", "value", directory], checkout.fsPath);
    await repository.status();

    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === directory
    );
    assert.ok(resource);

    await commands.executeCommand("svn.stage", resource);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === directory
      ),
      false
    );
    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === directory
      ),
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
