import * as path from "path";
import { TreeItem, TreeItemCollapsibleState } from "vscode";
import { WorkingCopySourceControl } from "../../workingCopySourceControl";
import { getIconUri } from "../../uri";
import BaseNode from "./baseNode";
import IncomingChangesNode from "./incomingChangesNode";

export default class RepositoryNode implements BaseNode {
  constructor(private workingCopy: WorkingCopySourceControl) {}

  get label() {
    return path.basename(this.workingCopy.root);
  }

  public getTreeItem(): TreeItem {
    const item = new TreeItem(this.label, TreeItemCollapsibleState.Collapsed);
    item.iconPath = {
      dark: getIconUri("repo", "dark"),
      light: getIconUri("repo", "light")
    };

    return item;
  }

  public async getChildren(): Promise<BaseNode[]> {
    return [new IncomingChangesNode(this.workingCopy)];
  }
}
