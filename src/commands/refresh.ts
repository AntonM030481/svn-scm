import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
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

    for (const scope of await workingCopyScopes(repository)) {
      if (refreshRemoteChanges) {
        await scope.updateRemoteChangedFiles();
      } else {
        await scope.status();
      }
    }
  }
}
