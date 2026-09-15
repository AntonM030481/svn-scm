import { Repository } from "../repository";
import { Command } from "./command";
import { uniqueScopeResources, workingCopyScopes } from "./workingCopyScopes";

export class PatchAll extends Command {
  constructor() {
    super("svn.patchAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const scopes = await workingCopyScopes(repository);
    await Promise.all(scopes.map(scope => scope.ensureStatus()));
    const resources = uniqueScopeResources(scopes, scope => [
      ...(scope.staged?.resourceStates ?? []),
      ...scope.changes.resourceStates,
      ...scope.conflicts.resourceStates,
      ...[...scope.changelists.values()].flatMap(group => group.resourceStates)
    ]);
    if (!resources.length) return;
    const content = await repository.patchFromRoot(
      resources.map(item => item.resource.resourceUri.fsPath)
    );
    if (!content) return;
    await this.showDiffPath(repository, content);
  }
}
