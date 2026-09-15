import { Repository } from "../repository";
import { Operation } from "../common/types";
import { Command } from "./command";
import { window } from "vscode";
import { runWorkingCopyOperation } from "./workingCopyScopes";

export class RemoveUnversioned extends Command {
  constructor() {
    super("svn.removeUnversioned", { repository: true });
  }

  public async execute(repository: Repository) {
    const answer = await window.showWarningMessage(
      "Are you sure? This will remove all unversioned files except for ignored.",
      { modal: true },
      "Yes",
      "No"
    );
    if (answer !== "Yes") {
      return;
    }
    await runWorkingCopyOperation(repository, Operation.CleanUp, scope =>
      scope.removeUnversioned()
    );
  }
}
