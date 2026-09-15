import { window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { Command } from "./command";
import {
  workingCopyOperationScopes,
  workingCopyScopes
} from "./workingCopyScopes";

export class Update extends Command {
  constructor() {
    super("svn.update", { repository: true });
  }

  public async execute(repository: Repository) {
    try {
      const ignoreExternals = configuration.get<boolean>(
        "update.ignoreExternals",
        false
      );
      const showUpdateMessage = configuration.get<boolean>(
        "showUpdateMessage",
        true
      );

      const allScopes = await workingCopyScopes(repository);
      const operationScopes = await workingCopyOperationScopes(repository);
      const owner = operationScopes[0];
      let result: string;
      try {
        result = await owner.updateRevision(
          ignoreExternals,
          operationScopes.map(scope => scope.workspaceRoot)
        );
        await Promise.all(
          allScopes
            .filter(scope => scope !== owner)
            .map(async scope => {
              await scope.status();
              void scope.updateRemoteChangedFiles();
            })
        );
      } catch (error) {
        await Promise.allSettled(allScopes.map(scope => scope.status()));
        throw error;
      }

      if (showUpdateMessage) {
        window.showInformationMessage(result);
      }
    } catch (error) {
      console.error(error);
      window.showErrorMessage("Unable to update");
    }
  }
}
