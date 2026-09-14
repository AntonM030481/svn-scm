import { ProgressLocation, window } from "vscode";
import { IBranchItem, SvnKindType } from "../common/types";
import FolderItem from "../quickPickItems/folderItem";
import NewFolderItem from "../quickPickItems/newFolderItem";
import ParentFolderItem from "../quickPickItems/parentFolderItem";
import { Repository } from "../repository";
import { matchLayout } from "./settingValues";
import { configuration } from "./configuration";

export function getBranchName(folder: string): IBranchItem | undefined {
  const confs = [
    ["layout.trunkRegex", "layout.trunkRegexName"],
    ["layout.branchesRegex", "layout.branchesRegexName"],
    ["layout.tagsRegex", "layout.tagRegexName"]
  ];

  for (const [conf, nameSetting] of confs) {
    const branch = matchLayout(
      folder,
      configuration.get(conf),
      configuration.get(nameSetting, 1)
    );
    if (branch) return branch;
  }

  return;
}

export async function selectBranch(
  repository: Repository,
  allowNew = false,
  folder?: string
): Promise<IBranchItem | undefined> {
  const promise = repository.repository.list(folder);

  window.withProgress(
    { location: ProgressLocation.Window, title: "Checking remote branches" },
    () => promise
  );

  const list = await promise;

  const dirs = list.filter(item => item.kind === SvnKindType.DIR);

  const picks = [];

  if (folder) {
    const parts = folder.split("/");
    parts.pop();
    const parent = parts.join("/");
    picks.push(new ParentFolderItem(parent));
  }

  if (allowNew && folder && !!getBranchName(`${folder}/test`)) {
    picks.push(new NewFolderItem(folder));
  }

  picks.push(...dirs.map(dir => new FolderItem(dir, folder)));

  const choice = await window.showQuickPick(picks);

  if (!choice) {
    return;
  }

  if (choice instanceof ParentFolderItem) {
    return selectBranch(repository, allowNew, choice.path);
  }
  if (choice instanceof FolderItem) {
    if (choice.branch) {
      return choice.branch;
    }

    return selectBranch(repository, allowNew, choice.path);
  }

  if (choice instanceof NewFolderItem) {
    const result = await window.showInputBox({
      prompt: "Please provide a branch name",
      ignoreFocusOut: true
    });

    if (!result) {
      return;
    }

    const name = result.replace(
      /^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g,
      "-"
    );

    const newBranch = getBranchName(`${folder}/${name}`);
    if (newBranch) {
      newBranch.isNew = true;
    }

    return newBranch;
  }

  return;
}

export function isTrunk(folder: string): boolean {
  return !!matchLayout(
    folder,
    configuration.get("layout.trunkRegex"),
    configuration.get("layout.trunkRegexName", 1)
  );
}
