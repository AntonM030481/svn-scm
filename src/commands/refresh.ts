import * as path from "path";
import { window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { getDisplayErrorMessage } from "../svnError";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class Refresh extends Command {
  constructor() {
    super("svn.refresh", { repository: true });
  }

  public async execute(repository: Repository) {
    const refreshRemoteChanges = configuration.get<boolean>(
      "refresh.remoteChanges",
      false
    );

    const failures: string[] = [];
    for (const scope of await workingCopyScopes(repository)) {
      try {
        if (refreshRemoteChanges) {
          await scope.updateRemoteChangedFiles();
        } else {
          await scope.status();
        }
      } catch (error) {
        failures.push(
          `${path.basename(scope.workspaceRoot)}: ${getDisplayErrorMessage(error)}`
        );
      }
    }
    if (failures.length) {
      window.showErrorMessage(`Unable to refresh: ${failures.join("; ")}`);
    }
  }
}
