import { Repository } from "../repository";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class PatchAll extends Command {
  constructor() {
    super("svn.patchAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const scopes = await workingCopyScopes(repository);
    const contents: string[] = [];
    for (const scope of scopes) {
      const resources = [
        ...scope.changes.resourceStates,
        ...scope.conflicts.resourceStates,
        ...[...scope.changelists.values()].flatMap(
          group => group.resourceStates
        )
      ];
      if (resources.length) {
        contents.push(
          await scope.patch(
            resources.map(resource => resource.resourceUri.fsPath)
          )
        );
      }
    }
    const content = contents.join("\n");
    if (!content) return;
    await this.showDiffPath(repository, content);
  }
}
