import { window } from "vscode";
import { configuration } from "./helpers/configuration";

export function noChangesToCommit() {
  return window.showInformationMessage("There are no changes to commit.");
}

export async function inputCommitMessage(
  message?: string
): Promise<string | undefined> {
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

    return allowEmpty === "Yes" ? "" : undefined;
  }

  return message;
}
