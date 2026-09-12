import * as path from "path";
import { randomBytes } from "crypto";
import { commands, Uri, ViewColumn, WebviewPanel, window } from "vscode";
import { SourceControlManager } from "./source_control_manager";
import { configuration } from "./helpers/configuration";
import {
  createCommitMessageInitialState,
  getCommitMessageWebviewHtml
} from "./webview/commitMessageHtml";

export function noChangesToCommit() {
  return window.showInformationMessage("There are no changes to commit.");
}

let panel: WebviewPanel;

// for tests only
let callback: (message: string) => void;
commands.registerCommand("svn.forceCommitMessageTest", (message: string) => {
  if (callback) {
    return callback(message);
  }
});

export function dispose() {
  if (panel) {
    panel.dispose();
  }
}

async function showCommitInput(message?: string, filePaths?: string[]) {
  const initialState = createCommitMessageInitialState(message, filePaths);
  const promise = new Promise<string | undefined>(resolve => {
    // Close previous commit message input
    if (panel) {
      panel.dispose();
    }

    // for tests only
    callback = (m: string) => {
      resolve(m);
      panel.dispose();
    };

    const cssRoot = Uri.file(path.join(__dirname, "..", "css"));
    panel = window.createWebviewPanel(
      "svnCommitMessage",
      "Commit Message",
      {
        preserveFocus: false,
        viewColumn: ViewColumn.Active
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [cssRoot]
      }
    );

    const stylePathOnDisk = Uri.file(
      path.join(__dirname, "..", "css", "commit-message.css")
    );
    const styleUri = panel.webview.asWebviewUri(stylePathOnDisk);
    panel.webview.html = getCommitMessageWebviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
      styleUri: styleUri.toString()
    });

    // On close
    panel.onDidDispose(() => {
      resolve(undefined);
    });

    const pickCommitMessage = async () => {
      let repository;

      if (filePaths && filePaths[0]) {
        const sourceControlManager = (await commands.executeCommand(
          "svn.getSourceControlManager",
          ""
        )) as SourceControlManager;
        repository = await sourceControlManager.getRepositoryFromUri(
          Uri.file(filePaths[0])
        );
      }

      const message = await commands.executeCommand(
        "svn.pickCommitMessage",
        repository
      );
      if (message !== undefined) {
        panel.webview.postMessage({
          command: "setMessage",
          message
        });
      }
    };

    // On button click
    panel.webview.onDidReceiveMessage(webviewMessage => {
      switch (webviewMessage.command) {
        case "ready":
          panel.webview.postMessage(initialState);
          break;
        case "commit":
          resolve(webviewMessage.message);
          panel.dispose();
          break;
        case "pickCommitMessage":
          pickCommitMessage();
          break;
        case "cancel":
          resolve(undefined);
          panel.dispose();
          break;
      }
    });

    // Force show and activate
    panel.reveal(ViewColumn.Active, false);
  });

  return promise;
}

export async function inputCommitMessage(
  message?: string,
  promptNew: boolean = true,
  filePaths?: string[]
): Promise<string | undefined> {
  if (promptNew) {
    message = await showCommitInput(message, filePaths);
  }

  const checkEmptyMessage = configuration.get<boolean>(
    "commit.checkEmptyMessage",
    true
  );

  if (message === "" && checkEmptyMessage) {
    const allowEmpty = await window.showWarningMessage(
      "Do you really want to commit an empty message?",
      { modal: true },
      "Yes"
    );

    if (allowEmpty === "Yes") {
      return "";
    } else {
      return undefined;
    }
  }
  return message;
}
