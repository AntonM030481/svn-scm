import { TreeItem, TreeItemCollapsibleState } from "vscode";
import { WorkingCopySourceControl } from "../../workingCopySourceControl";
import { getIconUri } from "../../uri";
import { normalizePath } from "../../util";
import BaseNode from "./baseNode";
import IncomingChangeNode from "./incomingChangeNode";
import NoIncomingChangesNode from "./noIncomingChangesNode";

export default class IncomingChangesNode implements BaseNode {
  constructor(private workingCopy: WorkingCopySourceControl) {}

  public getTreeItem(): TreeItem {
    const item = new TreeItem(
      "Incoming Changes",
      TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = {
      dark: getIconUri("download", "dark"),
      light: getIconUri("download", "light")
    };

    return item;
  }

  public async getChildren(): Promise<BaseNode[]> {
    const seen = new Set<string>();
    const changes = this.workingCopy.scopes.flatMap(repository =>
      (repository.remoteChanges?.resourceStates ?? []).flatMap(remoteChange => {
        const key = normalizePath(remoteChange.resourceUri.fsPath);
        if (seen.has(key)) return [];
        seen.add(key);
        return new IncomingChangeNode(
          remoteChange.resourceUri,
          remoteChange.type,
          repository
        );
      })
    );

    if (changes.length === 0) {
      return [new NoIncomingChangesNode()];
    }

    return changes;
  }
}
