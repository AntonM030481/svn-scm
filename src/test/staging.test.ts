import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { commands, ConfigurationTarget, Uri, window, workspace } from "vscode";
import { IFileStatus, Status } from "../common/types";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import {
  createStagingChangelist,
  parseStagingChangelist
} from "../stagingModel";
import { normalizePath } from "../util";
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

  test("repository owns one persistent staged group above Changes", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const stagedGroup = repository.staged;
    assert.ok(stagedGroup);
    assert.equal(stagedGroup.id, "staged");
    assert.equal(stagedGroup.label, "Staged Changes");
    assert.equal(stagedGroup.hideWhenEmpty, true);
    assert.equal(stagedGroup.repository, repository);

    const file = path.join(checkout.fsPath, "one", "a.txt");
    fs.writeFileSync(file, "ordered staging edit\n");
    await repository.status();
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);
    await commands.executeCommand("svn.stage", resource);

    assert.strictEqual(repository.staged, stagedGroup);
    assert.equal(
      stagedGroup.resourceStates.some(item => item.resourceUri.fsPath === file),
      true
    );
  });

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

  test("reserved staging groups are reconciled on nonpublishing projection rebuilds", async () => {
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
    await commands.executeCommand("svn.stage", resource);

    const statuses = await repository.repository.getStatus({
      includeIgnored: true,
      includeExternals: false,
      forceFull: true
    });
    const projection = repository as unknown as {
      applyStatus(
        statuses: IFileStatus[],
        checkRemoteChanges: boolean,
        preview?: boolean,
        publishStatus?: boolean
      ): void;
    };
    projection.applyStatus(statuses, false, true, false);

    const reserved = repository.changelists.get(createStagingChangelist());
    assert.equal(reserved?.resourceStates.length ?? 0, 0);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
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

  test("unstage preserves pre-existing added ancestor directories", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "pre-added");
    fs.mkdirSync(directory);
    svn(["add", "--depth", "empty", "pre-added"], checkout.fsPath);
    const file = path.join(directory, "child.txt");
    fs.writeFileSync(file, "child\n");
    await repository.status();

    const resource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    await commands.executeCommand("svn.stage", resource);
    await commands.executeCommand("svn.unstage", resource);

    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^A\s+pre-added$/m);
    assert.match(status, /^\?\s+pre-added[\\/]child\.txt$/m);
  });

  test("later files inherit a staging-created directory root", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "inherited-root");
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(first, "first\n");
    await repository.status();

    const folder = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === directory
    );
    assert.ok(folder);
    await commands.executeCommand("svn.stage", folder);

    fs.writeFileSync(second, "second\n");
    await repository.fullStatus();
    const secondResource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === second
    );
    assert.ok(secondResource);
    await commands.executeCommand("svn.stage", secondResource);

    const relativeRoot = path.relative(repository.root, directory);
    assert.equal(
      parseStagingChangelist(
        repository.stagedChangelists.get(normalizePath(second)) ?? ""
      )?.createdDirectoryRelativeRoot,
      relativeRoot
    );

    const firstStaged = repository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === first
    );
    const secondStaged = repository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === second
    );
    assert.ok(firstStaged);
    assert.ok(secondStaged);
    await commands.executeCommand("svn.unstage", firstStaged);
    await commands.executeCommand("svn.unstage", secondStaged);

    const status = svn(["status"], checkout.fsPath);
    assert.doesNotMatch(status, /^A\s+inherited-root$/m);
    assert.match(status, /^\?\s+inherited-root$/m);
  });

  test("unstaging after a working-copy move restores folder additions", async () => {
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
    const stagingChangelist = [...repository.stagedChangelists.values()][0];
    assert.ok(stagingChangelist);
    assert.equal(
      parseStagingChangelist(stagingChangelist)?.createdDirectoryRelativeRoot,
      path.relative(repository.root, directory)
    );

    sourceControlManager.close(repository);
    const movedCheckout = Uri.file(`${checkout.fsPath}-moved`);
    fs.renameSync(checkout.fsPath, movedCheckout.fsPath);
    await sourceControlManager.tryOpenRepository(movedCheckout.fsPath);
    const movedRepository = sourceControlManager.getRepository(
      movedCheckout
    ) as Repository;
    opened.push(movedRepository);
    await movedRepository.initialStatusSettled;
    assert.ok(movedRepository.staged?.resourceStates.length);

    await commands.executeCommand("svn.unstageAll", movedRepository.staged);
    const status = svn(["status"], movedCheckout.fsPath);
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

  test("unstage preserves hidden added descendants under a staged folder", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const directory = path.join(checkout.fsPath, "mixed-folder");
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
      svn(["add", hidden], checkout.fsPath);

      await commands.executeCommand("svn.unstageAll", repository.staged);
      const status = svn(["status"], checkout.fsPath);
      assert.match(status, /^A\s+mixed-folder$/m);
      assert.match(status, /^A\s+mixed-folder[\\/]hidden\.txt$/m);
      assert.match(status, /^\?\s+mixed-folder[\\/]visible\.txt$/m);
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

  test("sourceControl.ignore does not dereference staged symlinks", async () => {
    if (process.platform === "win32") return;

    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const svnConfiguration = workspace.getConfiguration("svn");
    const previousIgnore = svnConfiguration.inspect<string[]>(
      "sourceControl.ignore"
    )?.globalValue;
    await svnConfiguration.update(
      "sourceControl.ignore",
      ["**/*.ignored"],
      ConfigurationTarget.Global
    );

    try {
      const link = path.join(checkout.fsPath, "ignored-path-link");
      fs.symlinkSync("one", link);
      await repository.status();

      const resource = repository.unversioned.resourceStates.find(
        item => item.resourceUri.fsPath === link
      );
      assert.ok(resource);

      await commands.executeCommand("svn.stage", resource);
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === link
        ),
        true
      );
      assert.match(svn(["status"], checkout.fsPath), /^A\s+ignored-path-link/m);
    } finally {
      await svnConfiguration.update(
        "sourceControl.ignore",
        previousIgnore,
        ConfigurationTarget.Global
      );
    }
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

  test("stage and unstage refresh overlapping projections in one WC", async () => {
    const checkout = await createCheckoutWithFiles();
    const childRoot = path.join(checkout.fsPath, "one");
    const file = path.join(childRoot, "a.txt");

    await sourceControlManager.tryOpenRepository(childRoot);
    await sourceControlManager.tryOpenRepository(checkout.fsPath);

    const childRepository = sourceControlManager.repositories.find(
      candidate =>
        path.resolve(candidate.workspaceRoot) === path.resolve(childRoot)
    );
    const parentRepository = sourceControlManager.repositories.find(
      candidate =>
        path.resolve(candidate.workspaceRoot) === path.resolve(checkout.fsPath)
    );
    assert.ok(childRepository);
    assert.ok(parentRepository);
    assert.notStrictEqual(childRepository, parentRepository);
    opened.push(childRepository, parentRepository);

    fs.writeFileSync(file, "overlap edit\n");
    await childRepository.fullStatus();
    await parentRepository.fullStatus();

    const parentResource = parentRepository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(parentResource);

    await commands.executeCommand("svn.stage", parentResource);
    for (const repository of [childRepository, parentRepository]) {
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === file
        ),
        true
      );
      assert.equal(
        repository.changes.resourceStates.some(
          item => item.resourceUri.fsPath === file
        ),
        false
      );
    }

    const parentStaged = parentRepository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(parentStaged);
    await commands.executeCommand("svn.unstage", parentStaged);

    for (const repository of [childRepository, parentRepository]) {
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
    }
  });

  test("Switch and Merge preserve an already selected workspace scope", async () => {
    const checkout = await createCheckoutWithFiles();
    const one = path.join(checkout.fsPath, "one");
    const two = path.join(checkout.fsPath, "two");

    await sourceControlManager.tryOpenRepository(one);
    await sourceControlManager.tryOpenRepository(two);

    const repositoryOne = sourceControlManager.getRepository(Uri.file(one));
    const repositoryTwo = sourceControlManager.getRepository(Uri.file(two));
    assert.ok(repositoryOne);
    assert.ok(repositoryTwo);
    opened.push(repositoryOne, repositoryTwo);

    const originalShowQuickPick = window.showQuickPick;
    const placeholders: Array<string | undefined> = [];
    (window as any).showQuickPick = async (
      _items: readonly any[],
      options?: { placeHolder?: string }
    ) => {
      placeholders.push(options?.placeHolder);
      return undefined;
    };

    try {
      await commands.executeCommand("svn.switchBranch", Uri.file(one));
      await commands.executeCommand("svn.merge", Uri.file(one));
    } finally {
      window.showQuickPick = originalShowQuickPick;
    }

    assert.deepStrictEqual(placeholders, [undefined, undefined]);
  });

  test("palette commit routes staged active file through staged finalization", async () => {
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
    await commands.executeCommand("svn.stage", resource);

    await window.showTextDocument(Uri.file(file));
    repository.inputBox.value = "palette staged commit";
    await commands.executeCommand("svn.commit");
    assert.equal(svn(["status"], checkout.fsPath).trim(), "");

    fs.writeFileSync(file, "a2\n");
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
    await commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("palette commit refreshes staging membership after external unstage", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "one", "a.txt");
    fs.writeFileSync(file, "external-unstage edit\n");
    await repository.status();
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);
    await commands.executeCommand("svn.stage", resource);

    await window.showTextDocument(Uri.file(file));
    const svnConfiguration = workspace.getConfiguration("svn");
    const previousAutorefresh =
      svnConfiguration.inspect<boolean>("autorefresh")?.globalValue;

    try {
      await svnConfiguration.update(
        "autorefresh",
        false,
        ConfigurationTarget.Global
      );
      svn(["changelist", "--remove", file], checkout.fsPath);
      assert.doesNotMatch(
        svn(["status", "--xml"], checkout.fsPath),
        /__svn_scm_staged__/
      );

      repository.inputBox.value = "commit after external unstage";
      setTimeout(() => {
        void commands.executeCommand(
          "svn.forceCommitMessageTest",
          "commit after external unstage"
        );
      }, 100);
      await commands.executeCommand("svn.commit");
      assert.equal(svn(["status"], checkout.fsPath).trim(), "");
    } finally {
      await svnConfiguration.update(
        "autorefresh",
        previousAutorefresh,
        ConfigurationTarget.Global
      );
      await commands.executeCommand("workbench.action.closeActiveEditor");
    }
  });

  test("hidden staged files remain available to unstage all and commit staged", async () => {
    const checkout = await createCheckoutWithFiles();
    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    const file = path.join(checkout.fsPath, "one", "a.txt");
    const filesConfiguration = workspace.getConfiguration("files", checkout);
    const previousExclude =
      filesConfiguration.inspect<Record<string, boolean>>(
        "exclude"
      )?.globalValue;
    const hiddenExclude = {
      ...(previousExclude ?? {}),
      "**/one/a.txt": true
    };

    try {
      fs.writeFileSync(file, "a1\n");
      await repository.status();
      let resource = repository.changes.resourceStates.find(
        item => item.resourceUri.fsPath === file
      );
      assert.ok(resource);
      await commands.executeCommand("svn.stage", resource);

      await filesConfiguration.update(
        "exclude",
        hiddenExclude,
        ConfigurationTarget.Global
      );
      await repository.fullStatus();
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === file
        ),
        false
      );

      await commands.executeCommand("svn.unstageAll", repository.sourceControl);
      assert.match(svn(["status"], checkout.fsPath), /^M\s+one[\\/]a\.txt$/m);
      assert.doesNotMatch(
        svn(["status", "--xml"], checkout.fsPath),
        /__svn_scm_staged__/
      );

      await filesConfiguration.update(
        "exclude",
        previousExclude,
        ConfigurationTarget.Global
      );
      await repository.fullStatus();
      resource = repository.changes.resourceStates.find(
        item => item.resourceUri.fsPath === file
      );
      assert.ok(resource);
      await commands.executeCommand("svn.stage", resource);

      await filesConfiguration.update(
        "exclude",
        hiddenExclude,
        ConfigurationTarget.Global
      );
      await repository.fullStatus();
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === file
        ),
        false
      );

      repository.inputBox.value = "commit hidden staged file";
      await commands.executeCommand(
        "svn.commitStaged",
        repository.sourceControl
      );
      assert.equal(svn(["status"], checkout.fsPath).trim(), "");
    } finally {
      await filesConfiguration.update(
        "exclude",
        previousExclude,
        ConfigurationTarget.Global
      );
    }
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
    assert.strictEqual(
      repositoryOne.sourceControl,
      repositoryTwo.sourceControl
    );
    assert.equal(
      sourceControlManager.workingCopies.filter(
        workingCopy => workingCopy.sourceControl === repositoryOne.sourceControl
      ).length,
      1
    );

    const fileOne = path.join(one, "a.txt");
    const fileTwo = path.join(two, "b.txt");
    fs.writeFileSync(fileOne, "a1\n");
    svn(["delete", path.join("two", "b.txt")], checkout.fsPath);
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
    assert.equal(resourceTwo.type, Status.DELETED);

    await commands.executeCommand("svn.stage", resourceOne);
    await commands.executeCommand("svn.stage", resourceTwo);

    const workingCopy = sourceControlManager.workingCopies.find(
      candidate => candidate.sourceControl === repositoryOne.sourceControl
    );
    assert.ok(workingCopy);
    workingCopy.refresh();
    assert.deepEqual(
      workingCopy.staged.resourceStates
        .map(resource => resource.resourceUri.fsPath)
        .sort(),
      [fileOne, fileTwo].sort()
    );

    workingCopy.sourceControl.inputBox.value = "shared staged commit";
    await commands.executeCommand(
      "svn.commitStaged",
      repositoryOne.sourceControl
    );

    assert.equal(svn(["status"], checkout.fsPath).trim(), "");
    assert.equal(fs.existsSync(fileTwo), false);
    assert.equal(repositoryOne.inputBox.value, "");
    const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
    assert.match(log, /one[\\/]a\.txt/);
    assert.match(log, /two[\\/]b\.txt/);
  });
});
