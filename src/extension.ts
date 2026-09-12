import * as path from "path";
import {
  commands,
  Disposable,
  ExtensionContext,
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

type SourceControlManagerResolver = (
  value: SourceControlManager | PromiseLike<SourceControlManager>
) => void;
type SourceControlManagerRejecter = (reason?: unknown) => void;

async function init(
  extensionContext: ExtensionContext,
  outputChannel: OutputChannel,
  disposables: Disposable[],
  resolveSourceControlManager: SourceControlManagerResolver
) {
  const pathHint = configuration.get<string>("path");
  const svnFinder = new SvnFinder();

  const info = await svnFinder.findSvn(pathHint);
  const svn = new Svn({ svnPath: info.path, version: info.version });

  const onOutput = (str: string) => outputChannel.append(str);
  svn.onOutput.addListener("log", onOutput);
  disposables.push(
    toDisposable(() => svn.onOutput.removeListener("log", onOutput))
  );

  outputChannel.appendLine(`Using svn "${info.version}" from "${info.path}"`);

  const sourceControlManager = await new SourceControlManager(
    svn,
    ConstructorPolicy.Async,
    extensionContext
  );

  resolveSourceControlManager(sourceControlManager);

  enableIncrementalStatusRefresh(sourceControlManager, disposables);
  enableTargetedStatusLogReasons(sourceControlManager, disposables);
  registerCommands(sourceControlManager, disposables);

  disposables.push(
    sourceControlManager,
    new SvnProvider(sourceControlManager),
    new RepoLogProvider(sourceControlManager),
    new ItemLogProvider(sourceControlManager),
    new BranchChangesProvider(sourceControlManager),
    new CheckActiveEditor(sourceControlManager),
    new OpenRepositoryCount(sourceControlManager),
    new IsSvn18orGreater(info.version),
    new IsSvn19orGreater(info.version)
  );

  disposables.push(toDisposable(messages.dispose));
}

async function _activate(context: ExtensionContext, disposables: Disposable[]) {
  const outputChannel = window.createOutputChannel("Svn");
  commands.registerCommand("svn.showOutput", () => outputChannel.show());
  disposables.push(outputChannel);

  tempSvnFs.register();
  disposables.push(tempSvnFs);

  // Register the svn: scheme before any asynchronous initialization. VS Code
  // can restore BASE/diff editors immediately when the window opens, even while
  // the SVN executable is still being discovered.
  let resolveSourceControlManager!: SourceControlManagerResolver;
  let rejectSourceControlManager!: SourceControlManagerRejecter;
  const sourceControlManagerReady = new Promise<SourceControlManager>(
    (resolve, reject) => {
      resolveSourceControlManager = resolve;
      rejectSourceControlManager = reject;
    }
  );
  disposables.push(new SvnFileSystemProvider(sourceControlManagerReady));

  const showOutput = configuration.get<boolean>("showOutput");

  if (showOutput) {
    outputChannel.show();
  }

  const tryInit = async (): Promise<void> => {
    try {
      await init(
        context,
        outputChannel,
        disposables,
        resolveSourceControlManager
      );
    } catch (err) {
      const message = getErrorMessage(err);
      if (!/Svn installation not found/.test(message)) {
        rejectSourceControlManager(err);
        throw err;
      }

      try {
        const shouldIgnore =
          configuration.get<boolean>("ignoreMissingSvnWarning") === true;

        if (shouldIgnore) {
          rejectSourceControlManager(err);
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
        rejectSourceControlManager(err);
      } catch (recoveryError) {
        rejectSourceControlManager(recoveryError);
        throw recoveryError;
      }
    }
  };

  await tryInit();
}

export async function activate(context: ExtensionContext) {
  const disposables: Disposable[] = [];
  context.subscriptions.push(
    new Disposable(() => Disposable.from(...disposables).dispose())
  );

  await _activate(context, disposables).catch(err => console.error(err));
}

// this method is called when your extension is deactivated

function deactivate() {}
exports.deactivate = deactivate;
