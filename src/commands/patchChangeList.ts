import { window } from "vscode";
import { Repository } from "../repository";
import { Command } from "./command";
import { uniqueScopeResources, workingCopyScopes } from "./workingCopyScopes";

export class PatchChangeList extends Command {
  constructor() {
    super("svn.patchChangeList", { repository: true });
  }

  public async execute(repository: Repository) {
    const scopes = await workingCopyScopes(repository);
    const names = [
      ...new Set(
        scopes.flatMap(scope =>
          [...scope.changelists]
            .filter(([, group]) => group.resourceStates.length)
            .map(([name]) => name)
        )
      )
    ];
    if (!names.length) {
      window.showErrorMessage("No changelists to pick from");
      return;
    }
    const changelistName = await window.showQuickPick(names, {
      placeHolder: "Select a changelist"
    });

    if (!changelistName) {
      return;
    }

    const resources = uniqueScopeResources(
      scopes,
      scope => scope.changelists.get(changelistName)?.resourceStates ?? []
    );
    const contents: string[] = [];
    for (const scope of scopes) {
      const paths = resources
        .filter(item => item.scope === scope)
        .map(item => item.resource.resourceUri.fsPath);
      if (paths.length) contents.push(await scope.patch(paths));
    }
    const content = contents.join("\n");
    await this.showDiffPath(repository, content);
  }
}
