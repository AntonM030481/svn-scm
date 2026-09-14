import * as path from "path";
import {
  commands,
  ExtensionContext,
  ExtensionMode,
  OutputChannel,
  Uri,
  window
} from "vscode";
import { registerCommands } from "./commands";
import { ConstructorPolicy } from "./common/types";
import { CheckActiveEditor } from "./contexts/checkActiveEditor";
import { OpenRepositoryCount } from "./contexts/openRepositoryCount";
import { configuration } from "./helpers/configuration";
import { ItemLogProvider } from "./historyView/itemLogProvider";
import { RepoLogProvider } from "./historyView/repoLogProvider";
import * as messages from "./messages";
import { SourceControlManager } from "./source_control_manager";
import { Svn } from "./svn";
import { getErrorMessage } from "./svnError";
import { SvnFinder } from "./svnFinder";
import SvnProvider from "./treeView/dataProviders/svnProvider";
import { toDisposable } from "./util";
import { BranchChangesProvider } from "./historyView/branchChangesProvider";
import { IsSvn19orGreater } from "./contexts/isSvn19orGreater";
import { IsSvn18orGreater } from "./contexts/isSvn18orGreater";
import { tempSvnFs } from "./temp_svn_fs";
import { SvnFileSystemProvider } from "./svnFileSystemProvider";
import { enableIncrementalStatusRefresh } from "./incrementalStatus";
import { enableTargetedStatusLogReasons } from "./svnLogReasons";
import { DisposableScope, InitializationTransaction } from "./lifecycle";
import { UnversionedDirectoryContents } from "./unversionedDirectoryContents";

async function init(
  extensionContext: ExtensionContext,
  outputChannel: OutputChannel,
  transaction: InitializationTransaction<SourceControlManager>
) {
  const attempt = transaction.add(new DisposableScope());
  try {
    return await initializeAttempt(
      extensionContext,
      outputChannel,
      attempt,
      transaction.ready
    );
  } catch (error) {
    attempt.dispose();
    throw error;
  }
}

async function initializeAttempt(
  extensionContext: ExtensionContext,
  outputChannel: OutputChannel,
  attempt: DisposableScope,
  ready: Promise<SourceControlManager>
): Promise<SourceControlManager> {
  const disposables = attempt.disposables;
  const pathHint = configuration.get<string>("path");
  const svnFinder = new SvnFinder();

  const info = await svnFinder.findSvn(pathHint);
  attempt.assertActive();
  const svn = new Svn({ svnPath: info.path, version: info.version });

  const onOutput = (str: string) => outputChannel.append(str);
  svn.onOutput.addListener("log", onOutput);
  disposables.push(
    toDisposable(() => svn.onOutput.removeListener("log", onOutput))
  );

  outputChannel.appendLine(`Using svn "${info.version}" from "${info.path}"`);

  const sourceControlManager = attempt.add(
    new SourceControlManager(svn, ConstructorPolicy.LateInit, extensionContext)
  );

  enableIncrementalStatusRefresh(sourceControlManager, disposables);
  enableTargetedStatusLogReasons(sourceControlManager, disposables);
  attempt.add(new UnversionedDirectoryContents(sourceControlManager));
  registerCommands(sourceControlManager, disposables, ready);

  // Cache-backed consumers seed their state from the initial repository set.
  // The manager is already owned, but its public readiness remains gated until
  // every following view/context acquisition succeeds.
  await sourceControlManager.initialize();
  attempt.assertActive();

  attempt.add(new SvnProvider(sourceControlManager));
  attempt.add(new RepoLogProvider(sourceControlManager));
  attempt.add(new ItemLogProvider(sourceControlManager));
  attempt.add(new BranchChangesProvider(sourceControlManager));
  await attempt.add(new CheckActiveEditor(sourceControlManager)).initialized;
  attempt.assertActive();
  await attempt.add(new OpenRepositoryCount(sourceControlManager)).initialized;
  attempt.assertActive();
  await attempt.add(new IsSvn18orGreater(info.version)).initialized;
  attempt.assertActive();
  await attempt.add(new IsSvn19orGreater(info.version)).initialized;
  attempt.assertActive();

  disposables.push(toDisposable(messages.dispose));
  if (extensionContext.extensionMode === ExtensionMode.Test) {
    attempt.add(messages.registerTestCommand());
  }
  return sourceControlManager;
}

async function _activate(context: ExtensionContext, scope: DisposableScope) {
  scope.add(configuration);
  configuration.register();
  const transaction = scope.add(
    new InitializationTransaction<SourceControlManager>()
  );
  const outputChannel = scope.add(window.createOutputChannel("Svn"));
  scope.add(
    commands.registerCommand("svn.showOutput", () => outputChannel.show())
  );

  scope.add(tempSvnFs);
  tempSvnFs.register();

  // Register the svn: scheme before any asynchronous initialization. VS Code
  // can restore BASE/diff editors immediately when the window opens, even while
  // the SVN executable is still being discovered.
  scope.add(new SvnFileSystemProvider(transaction.ready));

  const showOutput = configuration.get<boolean>("showOutput");

  if (showOutput) {
    outputChannel.show();
  }

  const tryInit = async (): Promise<void> => {
    try {
      transaction.commit(await init(context, outputChannel, transaction));
    } catch (err) {
      const message = getErrorMessage(err);
      if (!/Svn installation not found/.test(message)) {
        transaction.fail(err);
        throw err;
      }

      try {
        const shouldIgnore =
          configuration.get<boolean>("ignoreMissingSvnWarning") === true;

        if (shouldIgnore) {
          transaction.fail(err);
          return;
        }

        console.warn(message);
        outputChannel.appendLine(message);
        outputChannel.show();

        const findSvnExecutable = "Find SVN executable";
        const download = "Download SVN";
        const neverShowAgain = "Don't Show Again";
        const choice = await window.showWarningMessage(
          "SVN not found. Install it or configure it using the 'svn.path' setting.",
          findSvnExecutable,
          download,
          neverShowAgain
        );
        scope.assertActive();

        if (choice === findSvnExecutable) {
          let filters: { [name: string]: string[] } | undefined;

          // For windows, limit to executable files
          if (path.sep === "\\") {
            filters = {
              svn: ["exe", "bat"]
            };
          }

          const executable = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters
          });
          scope.assertActive();

          if (executable && executable[0]) {
            const file = executable[0].fsPath;

            outputChannel.appendLine(`Updated "svn.path" with "${file}"`);

            await configuration.update("path", file);

            // Try Re-init after select the executable
            return tryInit();
          }
        } else if (choice === download) {
          commands.executeCommand(
            "vscode.open",
            Uri.parse("https://subversion.apache.org/packages.html")
          );
        } else if (choice === neverShowAgain) {
          await configuration.update("ignoreMissingSvnWarning", true);
        }

        // No further initialization attempt will be made during this activation.
        // Reject restored svn: documents instead of leaving them loading forever.
        transaction.fail(err);
      } catch (recoveryError) {
        transaction.fail(recoveryError);
        throw recoveryError;
      }
    }
  };

  await tryInit();
}

export async function activate(context: ExtensionContext) {
  const scope = new DisposableScope();
  context.subscriptions.push(scope);
  try {
    await _activate(context, scope);
  } catch (error) {
    scope.dispose();
    throw error;
  }
}

// this method is called when your extension is deactivated

function deactivate() {}
exports.deactivate = deactivate;
