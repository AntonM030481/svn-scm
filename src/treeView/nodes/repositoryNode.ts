import * as path from "path";
import { TreeItem, TreeItemCollapsibleState } from "vscode";
import { Repository } from "../../repository";
import { getIconUri } from "../../uri";
import SvnProvider from "../dataProviders/svnProvider";
import BaseNode from "./baseNode";
import IncomingChangesNode from "./incomingChangesNode";

export default class RepositoryNode implements BaseNode {
  constructor(
    private repositories: Repository[],
    private svnProvider: SvnProvider
  ) {
    repositories.forEach(repository =>
      repository.onDidChangeStatus(() => this.svnProvider.update(this))
    );
  }

  get label() {
    return path.basename(this.repositories[0].root);
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
    return [new IncomingChangesNode(this.repositories)];
  }
}
