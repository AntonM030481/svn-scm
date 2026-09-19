import * as assert from "assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import {
  commands,
  ConfigurationTarget,
  extensions,
  Uri,
  window,
  workspace
} from "vscode";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import * as testUtil from "./testUtil";

function svn(args: string[], cwd: string): string {
  return cp.execFileSync("svn", args, { cwd, encoding: "utf8" });
}

suite("Staging UI Argument Tests", () => {
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

  test("manifest exposes Git-like folder and group staging actions", () => {
    const extension = extensions.getExtension("antonm030481.svn-scm-modern");
    assert.ok(extension);

    const menus = extension.packageJSON.contributes.menus as Record<
      string,
      Array<{ command: string; when?: string; group?: string }>
    >;
    const folderMenu = menus["scm/resourceFolder/context"] ?? [];
    const groupMenu = menus["scm/resourceGroup/context"] ?? [];
    const resourceMenu = menus["scm/resourceState/context"] ?? [];
    const registeredCommands = extension.packageJSON.contributes
      .commands as Array<{
      command: string;
      icon?: string;
    }>;

    assert.equal(
      registeredCommands.find(item => item.command === "svn.deleteUnversioned")
        ?.icon,
      "$(trash)"
    );

    assert.ok(
      folderMenu.some(
        item =>
          item.command === "svn.stage" &&
          item.when?.includes("scmResourceGroup != staged")
      )
    );
    assert.ok(
      folderMenu.some(
        item =>
          item.command === "svn.deleteUnversioned" &&
          item.when?.includes("scmResourceGroup == unversioned") &&
          item.group?.startsWith("inline")
      )
    );
    assert.ok(
      folderMenu.some(
        item =>
          item.command === "svn.unstage" &&
          item.when?.includes("scmResourceGroup == staged")
      )
    );
    assert.ok(
      folderMenu.some(
        item =>
          item.command === "svn.revert" &&
          item.when?.includes("scmResourceGroup == changes")
      )
    );
    assert.equal(
      folderMenu.some(
        item =>
          item.command === "svn.revert" &&
          item.when?.includes("scmResourceGroup == staged")
      ),
      false
    );

    assert.ok(
      groupMenu.some(
        item =>
          item.command === "svn.stage" &&
          item.when?.includes("scmResourceGroup == unversioned") &&
          item.group?.startsWith("inline")
      )
    );
    assert.ok(
      groupMenu.some(
        item =>
          item.command === "svn.deleteUnversioned" &&
          item.when?.includes("scmResourceGroup == unversioned") &&
          item.group?.startsWith("inline")
      )
    );
    assert.equal(
      groupMenu.some(
        item =>
          item.command === "svn.stageAll" &&
          item.when?.includes("scmResourceGroup == unversioned")
      ),
      false
    );
    assert.ok(
      groupMenu.some(
        item =>
          item.command === "svn.unstageAll" &&
          item.when?.includes("scmResourceGroup == staged")
      )
    );
    assert.equal(
      groupMenu.some(
        item =>
          item.command === "svn.revertAll" &&
          item.when?.includes("scmResourceGroup == staged")
      ),
      false
    );
    assert.ok(
      resourceMenu.some(
        item =>
          item.command === "svn.deleteUnversioned" &&
          item.when?.includes("scmResourceGroup == unversioned") &&
          !item.group?.startsWith("inline")
      )
    );
    assert.ok(
      resourceMenu.some(
        item =>
          item.command === "svn.deleteUnversioned" &&
          item.group?.startsWith("inline")
      )
    );
  });

  test("Unversioned group Stage does not stage neighboring changes", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const tracked = path.join(checkout.fsPath, "tracked.txt");
    const unversioned = path.join(checkout.fsPath, "unversioned.txt");
    fs.writeFileSync(tracked, "base\n");
    svn(["add", "tracked.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(tracked, "changed\n");
    fs.writeFileSync(unversioned, "new\n");
    await repository.status();

    await commands.executeCommand("svn.stage", repository.unversioned);

    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === unversioned
      ),
      true
    );
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === tracked
      ),
      false
    );
    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === tracked
      ),
      true
    );
  });

  test("Unversioned folder and group Delete remove their selected roots", async () => {
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

    const directory = path.join(checkout.fsPath, "folder");
    const nested = path.join(directory, "nested", "child.txt");
    const trackedDirectory = path.join(checkout.fsPath, "tracked-folder");
    const trackedBase = path.join(trackedDirectory, "base.txt");
    const trackedNew = path.join(trackedDirectory, "new.txt");
    const remaining = path.join(checkout.fsPath, "remaining.txt");
    fs.mkdirSync(trackedDirectory);
    fs.writeFileSync(trackedBase, "base\n");
    svn(["add", "tracked-folder"], checkout.fsPath);
    svn(["commit", "-m", "tracked folder"], checkout.fsPath);
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "nested\n");
    fs.writeFileSync(trackedNew, "new\n");
    fs.writeFileSync(remaining, "remaining\n");
    await repository.status();

    const originalWarning = window.showWarningMessage;
    const config = workspace.getConfiguration("svn");
    const previousAutorefresh = config.inspect<boolean>("autorefresh")?.globalValue;
    const base = repository.repository;
    const originalExec = base.exec.bind(base);
    let targetedStatuses = 0;
    let untargetedStatuses = 0;

    (window as any).showWarningMessage = async () => "Yes";
    base.exec = async (args, options) => {
      if (args[0] === "stat") {
        const text = args.join(" ");
        if (/folder|remaining\.txt/.test(text)) {
          targetedStatuses += 1;
        } else {
          untargetedStatuses += 1;
        }
      }
      return originalExec(args, options);
    };

    try {
      await config.update("autorefresh", false, ConfigurationTarget.Global);

      await commands.executeCommand("svn.deleteUnversioned", {
        uri: Uri.file(directory),
        context: repository.unversioned
      });
      assert.equal(fs.existsSync(directory), false);
      assert.equal(fs.existsSync(remaining), true);
      assert.equal(repository.getResourceFromFile(Uri.file(directory)), undefined);

      await commands.executeCommand("svn.deleteUnversioned", {
        uri: Uri.file(trackedDirectory),
        context: repository.unversioned
      });
      assert.equal(fs.existsSync(trackedDirectory), true);
      assert.equal(fs.existsSync(trackedBase), true);
      assert.equal(fs.existsSync(trackedNew), false);
      assert.equal(repository.getResourceFromFile(Uri.file(trackedNew)), undefined);

      await commands.executeCommand(
        "svn.deleteUnversioned",
        repository.unversioned
      );
      assert.equal(fs.existsSync(remaining), false);
      assert.equal(repository.getResourceFromFile(Uri.file(remaining)), undefined);
      assert.ok(targetedStatuses >= 3);
      assert.equal(untargetedStatuses, 0);
    } finally {
      base.exec = originalExec;
      await config.update(
        "autorefresh",
        previousAutorefresh,
        ConfigurationTarget.Global
      );
      window.showWarningMessage = originalWarning;
    }
  });

  test("Stage and Unstage accept SCM tree resource-node arguments", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const file = path.join(checkout.fsPath, "file.txt");
    fs.writeFileSync(file, "base\n");
    svn(["add", "file.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(file, "changed\n");
    await repository.status();
    const resource = repository.changes.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    // SCM tree view uses an IResourceNode wrapper as the inline action context.
    // The actual SourceControlResourceState is stored in `element`.
    const treeResourceNode = { element: resource };
    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", treeResourceNode);
    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );

    const stagedResource = repository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(stagedResource);
    await commands.executeCommand("svn.unstage", {
      element: stagedResource
    });
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
    assert.equal(fullStatusCalls, 0);
  });

  test("SCM tree folders unstage without reverting file contents", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const checkout = await testUtil.createRepoCheckout(
      `${testUtil.getSvnUrl(repoUri)}/trunk`
    );
    const directory = path.join(checkout.fsPath, "folder");
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(first, "base first\n");
    fs.writeFileSync(second, "base second\n");
    svn(["add", "folder"], checkout.fsPath);
    svn(["commit", "-m", "initial folder"], checkout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(first, "changed first\n");
    fs.writeFileSync(second, "changed second\n");
    svn(["propset", "test:property", "changed", "folder"], checkout.fsPath);
    await repository.status();

    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", {
      uri: Uri.file(directory),
      context: repository.changes
    });
    assert.equal(repository.staged?.resourceStates.length, 2);

    await commands.executeCommand("svn.unstage", {
      uri: Uri.file(directory),
      context: repository.staged
    });
    assert.equal(repository.staged?.resourceStates.length, 0);
    const changedPaths = repository.changes.resourceStates.map(
      resource => resource.resourceUri.fsPath
    );
    assert.equal(changedPaths.includes(first), true);
    assert.equal(changedPaths.includes(second), true);
    assert.equal(fs.readFileSync(first, "utf8"), "changed first\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed second\n");
    assert.equal(
      repository.changes.resourceStates.some(
        resource => resource.resourceUri.fsPath === directory
      ),
      true
    );

    await commands.executeCommand("svn.stage", {
      uri: Uri.file(directory),
      context: repository.changes
    });
    assert.equal(repository.staged?.resourceStates.length, 2);

    await commands.executeCommand("svn.unstageAll", repository.staged);
    assert.equal(repository.staged?.resourceStates.length, 0);
    assert.equal(fs.readFileSync(first, "utf8"), "changed first\n");
    assert.equal(fs.readFileSync(second, "utf8"), "changed second\n");
    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^M\s+folder[\\/]first\.txt\r?$/m);
    assert.match(status, /^M\s+folder[\\/]second\.txt\r?$/m);
    assert.equal(fullStatusCalls, 0);
  });

  test("Stage accepts an unversioned SCM tree resource-node argument", async () => {
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

    const file = path.join(checkout.fsPath, "new.txt");
    fs.writeFileSync(file, "new\n");
    await repository.status();
    const resource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(resource);

    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", { element: resource });

    assert.equal(
      repository.staged?.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
    assert.match(svn(["status"], checkout.fsPath), /^A\s+new\.txt$/m);
    assert.match(
      svn(["status", "--xml"], checkout.fsPath),
      /__svn_scm_staged__/
    );

    const stagedResource = repository.staged?.resourceStates.find(
      item => item.resourceUri.fsPath === file
    );
    assert.ok(stagedResource);
    await commands.executeCommand("svn.unstage", { element: stagedResource });

    assert.equal(
      repository.unversioned.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
    assert.match(svn(["status"], checkout.fsPath), /^\?\s+new\.txt$/m);
    assert.equal(fullStatusCalls, 0);
  });

  test("Commit Staged includes hidden added parent directories", async () => {
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

    const directory = path.join(checkout.fsPath, "hidden-added");
    const file = path.join(directory, "child.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, "child\n");
    await repository.status();

    const resource = repository.unversioned.resourceStates.find(
      item => item.resourceUri.fsPath === directory
    );
    assert.ok(resource);
    await commands.executeCommand("svn.stage", { element: resource });

    const filesConfiguration = workspace.getConfiguration("files", checkout);
    const previousExclude =
      filesConfiguration.inspect<Record<string, boolean>>(
        "exclude"
      )?.globalValue;

    try {
      await filesConfiguration.update(
        "exclude",
        { ...(previousExclude ?? {}), "**/hidden-added": true },
        ConfigurationTarget.Global
      );
      await repository.fullStatus();
      assert.equal(repository.getResourceFromFile(directory), undefined);
      assert.equal(
        repository.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === file
        ),
        true
      );

      repository.inputBox.value = "commit hidden added directory";
      await commands.executeCommand(
        "svn.commitStaged",
        repository.sourceControl
      );

      assert.equal(svn(["status"], checkout.fsPath).trim(), "");
      const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
      assert.match(log, /hidden-added/);
      assert.match(log, /child\.txt/);
    } finally {
      await filesConfiguration.update(
        "exclude",
        previousExclude,
        ConfigurationTarget.Global
      );
    }
  });

  test("Commit Staged skips conflicted staged files", async () => {
    const repoUri = await testUtil.createRepoServer();
    await testUtil.createStandardLayout(testUtil.getSvnUrl(repoUri));
    const trunkUrl = `${testUtil.getSvnUrl(repoUri)}/trunk`;
    const checkout = await testUtil.createRepoCheckout(trunkUrl);
    const peerCheckout = await testUtil.createRepoCheckout(trunkUrl);
    const conflictedFile = path.join(checkout.fsPath, "conflicted.txt");
    const cleanFile = path.join(checkout.fsPath, "clean.txt");

    fs.writeFileSync(conflictedFile, "base\n");
    fs.writeFileSync(cleanFile, "base\n");
    svn(["add", "conflicted.txt", "clean.txt"], checkout.fsPath);
    svn(["commit", "-m", "initial"], checkout.fsPath);
    svn(["update"], peerCheckout.fsPath);

    await sourceControlManager.tryOpenRepository(checkout.fsPath);
    const repository = sourceControlManager.getRepository(
      checkout
    ) as Repository;
    opened.push(repository);

    fs.writeFileSync(conflictedFile, "local\n");
    fs.writeFileSync(cleanFile, "clean local\n");
    await repository.status();

    const conflictedResource = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === conflictedFile
    );
    const cleanResource = repository.changes.resourceStates.find(
      resource => resource.resourceUri.fsPath === cleanFile
    );
    assert.ok(conflictedResource);
    assert.ok(cleanResource);

    await commands.executeCommand("svn.stage", conflictedResource);
    await commands.executeCommand("svn.stage", cleanResource);

    fs.writeFileSync(
      path.join(peerCheckout.fsPath, "conflicted.txt"),
      "remote\n"
    );
    svn(
      ["commit", "-m", "remote change", "conflicted.txt"],
      peerCheckout.fsPath
    );
    svn(["update"], checkout.fsPath);
    await repository.fullStatus();

    const conflictInputs =
      await repository.getTextConflictInputs(conflictedFile);
    assert.ok(conflictInputs);
    assert.equal(fs.readFileSync(conflictInputs.current, "utf8"), "local\n");
    assert.equal(fs.readFileSync(conflictInputs.incoming, "utf8"), "remote\n");
    assert.equal(fs.readFileSync(conflictInputs.base, "utf8"), "base\n");

    assert.equal(
      repository.conflicts.resourceStates.some(
        resource => resource.resourceUri.fsPath === conflictedFile
      ),
      true
    );

    repository.inputBox.value = "commit clean staged file";
    await commands.executeCommand("svn.commitStaged", repository.sourceControl);

    const status = svn(["status"], checkout.fsPath);
    assert.match(status, /^C\s+conflicted\.txt$/m);
    assert.doesNotMatch(status, /^M\s+clean\.txt$/m);
    const log = svn(["log", "-r", "HEAD", "-v"], checkout.fsPath);
    assert.match(log, /clean\.txt/);
    assert.doesNotMatch(log, /conflicted\.txt/);
  });
});
