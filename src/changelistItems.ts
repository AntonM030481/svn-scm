import { QuickPickItem, window } from "vscode";
import { configuration } from "./helpers/configuration";
import ChangeListItem from "./quickPickItems/changeListItem";
import IgnoredChangeListItem from "./quickPickItems/ignoredChangeListItem";
import NewChangeListItem from "./quickPickItems/newChangeListItem";
import RemoveChangeListItem from "./quickPickItems/removeChangeListItem";
import { Repository } from "./repository";

export function getChangelistPickOptions(
  repository: Repository,
  canRemove = false
): QuickPickItem[] {
  const picks: QuickPickItem[] = [];

  picks.push(new NewChangeListItem());
  repository.changelists.forEach((group, _changelist) => {
    if (group.resourceStates.length) {
      picks.push(new ChangeListItem(group));
    }
  });

  const ignoreOnCommitList = configuration.get<string[]>(
    "sourceControl.ignoreOnCommit"
  );
  for (const ignoreOnCommit of ignoreOnCommitList) {
    if (!picks.some(p => p.label === ignoreOnCommit)) {
      picks.push(new IgnoredChangeListItem(ignoreOnCommit));
    }
  }

  if (canRemove) {
    picks.push(new RemoveChangeListItem());
  }

  return picks;
}

export function patchChangelistOptions(repository: Repository) {
  const picks: QuickPickItem[] = [];

  repository.changelists.forEach((group, _changelist) => {
    if (group.resourceStates.length) {
      picks.push(new ChangeListItem(group));
    }
  });

  return picks;
}

export async function getPatchChangelist(repository: Repository) {
  const picks: QuickPickItem[] = patchChangelistOptions(repository);

  if (!picks.length) {
    window.showErrorMessage("No changelists to pick from");
    return;
  }

  const selectedChoice: any = await window.showQuickPick(picks, {
    placeHolder: "Select a changelist"
  });
  if (!selectedChoice) {
    return;
  }

  return selectedChoice.label;
}
