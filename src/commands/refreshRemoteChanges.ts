import { Repository } from "../repository";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class RefreshRemoteChanges extends Command {
  constructor() {
    super("svn.refreshRemoteChanges", { repository: true });
  }

  public async execute(repository: Repository) {
    for (const scope of await workingCopyScopes(repository)) {
      await scope.updateRemoteChangedFiles();
    }
  }
}
