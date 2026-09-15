import * as path from "path";
import { window } from "vscode";
import { Repository } from "../repository";
import { getDisplayErrorMessage } from "../svnError";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class RefreshRemoteChanges extends Command {
  constructor() {
    super("svn.refreshRemoteChanges", { repository: true });
  }

  public async execute(repository: Repository) {
    const failures: string[] = [];
    for (const scope of await workingCopyScopes(repository)) {
      try {
        await scope.updateRemoteChangedFiles();
      } catch (error) {
        failures.push(
          `${path.basename(scope.workspaceRoot)}: ${getDisplayErrorMessage(error)}`
        );
      }
    }
    if (failures.length) {
      window.showErrorMessage(
        `Unable to refresh remote changes: ${failures.join("; ")}`
      );
    }
  }
}
