import { window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { Command } from "./command";
import { runWorkingCopyOperation } from "./workingCopyScopes";

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

      const results = await runWorkingCopyOperation(repository, scope =>
        scope.updateRevision(ignoreExternals)
      );

      if (showUpdateMessage) {
        window.showInformationMessage(results.join("\n"));
      }
    } catch (error) {
      console.error(error);
      window.showErrorMessage("Unable to update");
    }
  }
}
