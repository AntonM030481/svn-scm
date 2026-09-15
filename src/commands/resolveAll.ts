import { window } from "vscode";
import { getConflictPickOptions } from "../conflictItems";
import { Repository } from "../repository";
import { getDisplayErrorMessage } from "../svnError";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class ResolveAll extends Command {
  constructor() {
    super("svn.resolveAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const scopes = await workingCopyScopes(repository);
    await Promise.all(scopes.map(scope => scope.ensureStatus()));
    const conflicts = scopes.flatMap(scope => scope.conflicts.resourceStates);

    if (!conflicts.length) {
      window.showInformationMessage("No Conflicts");
    }

    for (const conflict of conflicts) {
      const placeHolder = `Select conflict option for ${conflict.resourceUri.path}`;
      const picks = getConflictPickOptions();

      const choice = await window.showQuickPick(picks, { placeHolder });

      if (!choice) {
        return;
      }

      try {
        const owner = scopes.find(scope =>
          scope.conflicts.resourceStates.includes(conflict)
        );
        if (!owner) continue;
        const response = await owner.resolve(
          [conflict.resourceUri.path],
          choice.label
        );
        window.showInformationMessage(response);
      } catch (error) {
        window.showErrorMessage(getDisplayErrorMessage(error));
      }
    }
  }
}
