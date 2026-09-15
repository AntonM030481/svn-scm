import { Repository } from "../repository";
import { Command } from "./command";
import { uniqueScopeResources, workingCopyScopes } from "./workingCopyScopes";

export class PatchAll extends Command {
  constructor() {
    super("svn.patchAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const scopes = await workingCopyScopes(repository);
    const contents: string[] = [];
    const resources = uniqueScopeResources(scopes, scope => [
      ...scope.changes.resourceStates,
      ...scope.conflicts.resourceStates,
      ...[...scope.changelists.values()].flatMap(group => group.resourceStates)
    ]);
    for (const scope of scopes) {
      const paths = resources
        .filter(item => item.scope === scope)
        .map(item => item.resource.resourceUri.fsPath);
      if (paths.length) contents.push(await scope.patch(paths));
    }
    const content = contents.join("\n");
    if (!content) return;
    await this.showDiffPath(repository, content);
  }
}
