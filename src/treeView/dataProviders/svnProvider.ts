import {
  commands,
  Event,
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Disposable,
  window
} from "vscode";
import { SourceControlManager } from "../../source_control_manager";
import BaseNode from "../nodes/baseNode";
import RepositoryNode from "../nodes/repositoryNode";
import { dispose } from "../../util";
import { registerResources } from "../../lifecycle";
import { WorkingCopySourceControl } from "../../workingCopySourceControl";

export default class SvnProvider
  implements TreeDataProvider<BaseNode>, Disposable
{
  private _onDidChangeTreeData: EventEmitter<BaseNode | undefined> =
    new EventEmitter<BaseNode | undefined>();
  private _dispose: Disposable[] = [];
  private workingCopySubscriptions = new Map<
    WorkingCopySourceControl,
    Disposable
  >();
  public onDidChangeTreeData: Event<BaseNode | undefined> =
    this._onDidChangeTreeData.event;

  constructor(private sourceControlManager: SourceControlManager) {
    registerResources(
      this._dispose,
      () => window.registerTreeDataProvider("svn", this),
      () =>
        commands.registerCommand("svn.treeview.refreshProvider", () =>
          this.refresh()
        )
    );
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: RepositoryNode): TreeItem {
    return element.getTreeItem();
  }

  public async getChildren(element?: BaseNode): Promise<BaseNode[]> {
    if (
      !this.sourceControlManager ||
      this.sourceControlManager.openRepositories.length === 0
    ) {
      return Promise.resolve([]);
    }

    if (element) {
      return element.getChildren();
    }

    const workingCopies = this.sourceControlManager.workingCopies;
    for (const [workingCopy, subscription] of this.workingCopySubscriptions) {
      if (!workingCopies.includes(workingCopy)) {
        subscription.dispose();
        this.workingCopySubscriptions.delete(workingCopy);
      }
    }
    for (const workingCopy of workingCopies) {
      if (!this.workingCopySubscriptions.has(workingCopy)) {
        this.workingCopySubscriptions.set(
          workingCopy,
          workingCopy.onDidChange(() => this.refresh())
        );
      }
    }

    const repositories = workingCopies.map(
      workingCopy => new RepositoryNode(workingCopy)
    );

    return repositories;
  }

  public update(node: BaseNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  public dispose() {
    this.workingCopySubscriptions.forEach(subscription =>
      subscription.dispose()
    );
    this.workingCopySubscriptions.clear();
    dispose(this._dispose);
  }
}
