import * as path from "path";
import {
  Command,
  Disposable,
  Event,
  EventEmitter,
  ProviderResult,
  QuickDiffProvider,
  scm,
  SourceControl,
  Uri
} from "vscode";
import { ISvnResourceGroup } from "./common/types";
import { getBranchName } from "./helpers/branch";
import { configuration } from "./helpers/configuration";
import { Repository } from "./repository";
import { Resource } from "./resource";
import { isDescendant, normalizePath } from "./util";

function uniqueResources(resources: Resource[]): Resource[] {
  const unique = new Map<string, Resource>();
  for (const resource of resources) {
    unique.set(normalizePath(resource.resourceUri.fsPath), resource);
  }
  return [...unique.values()];
}

function sourceControlId(root: string): string {
  let hash = 2166136261;
  for (const character of normalizePath(root)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `svn-${(hash >>> 0).toString(16)}`;
}

/** The single VS Code SCM projection for one physical SVN working copy. */
export class WorkingCopySourceControl implements Disposable, QuickDiffProvider {
  private readonly changeEmitter = new EventEmitter<void>();
  public readonly onDidChange: Event<void> = this.changeEmitter.event;
  public readonly label: string;
  public readonly sourceControl: SourceControl;
  public readonly staged: ISvnResourceGroup;
  public readonly changes: ISvnResourceGroup;
  public readonly conflicts: ISvnResourceGroup;
  public readonly unversioned: ISvnResourceGroup;
  public readonly scopes: Repository[] = [];

  private readonly changelists = new Map<string, ISvnResourceGroup>();
  private remoteChanges?: ISvnResourceGroup;
  private readonly scopeDisposables = new Map<Repository, Disposable[]>();
  private refreshQueued = false;
  private quickDiffEnabled = false;
  private disposed = false;

  constructor(
    public readonly root: string,
    private readonly resolveRepository: (uri: Uri) => Repository | null
  ) {
    // Newer VS Code versions use this optional label to distinguish Quick Diff
    // registrations owned by separate SCM providers.
    this.label = `SVN ${normalizePath(root)}`;
    this.sourceControl = scm.createSourceControl(
      sourceControlId(root),
      path.basename(root),
      Uri.file(root)
    );
    this.sourceControl.inputBox.placeholder =
      "Message (press Ctrl+Enter to commit)";
    this.sourceControl.acceptInputCommand = {
      command: "svn.commitStaged",
      title: "commit staged",
      arguments: [this.sourceControl]
    };
    this.staged = this.createGroup("staged", "Staged Changes");
    this.changes = this.createGroup("changes", "Changes");
    this.conflicts = this.createGroup("conflicts", "Conflicts");
    this.unversioned = this.createGroup("unversioned", "Unversioned");
  }

  public addScope(repository: Repository): void {
    if (this.scopes.includes(repository)) return;
    this.scopes.push(repository);
    this.scopes.sort(
      (left, right) => right.workspaceRoot.length - left.workspaceRoot.length
    );
    this.changeEmitter.fire();
    const disposables: Disposable[] = [];
    repository.onDidChangeStatus(
      () => {
        this.enableQuickDiff(true);
        this.queueRefresh();
      },
      this,
      disposables
    );
    repository.onDidRebuildStatusProjection(
      this.queueRefresh,
      this,
      disposables
    );
    repository.onDidChangeOperations(this.queueRefresh, this, disposables);
    this.scopeDisposables.set(repository, disposables);
    this.queueRefresh();
  }

  public removeScope(repository: Repository): void {
    const index = this.scopes.indexOf(repository);
    if (index < 0) return;
    this.scopes.splice(index, 1);
    this.scopeDisposables.get(repository)?.forEach(item => item.dispose());
    this.scopeDisposables.delete(repository);
    this.changeEmitter.fire();
    this.queueRefresh();
  }

  public refresh(): void {
    if (this.disposed) return;
    const representative = this.scopes[0];
    for (const group of [
      this.staged,
      this.changes,
      this.conflicts,
      this.unversioned
    ]) {
      group.repository = representative;
    }

    this.staged.resourceStates = this.collect(scope => scope.staged);
    this.changes.resourceStates = this.collect(scope => scope.changes);
    this.conflicts.resourceStates = this.collect(scope => scope.conflicts);
    this.unversioned.resourceStates = this.collect(scope => scope.unversioned);

    const names = new Set<string>();
    for (const scope of this.scopes) {
      scope.changelists.forEach((_group, name) => names.add(name));
    }
    for (const [name, group] of [...this.changelists]) {
      if (!names.has(name)) {
        group.dispose();
        this.changelists.delete(name);
      }
    }
    for (const name of names) {
      let group = this.changelists.get(name);
      if (!group) {
        group = this.createGroup(`changelist-${name}`, `Changelist "${name}"`);
        this.changelists.set(name, group);
      }
      group.repository = representative;
      group.resourceStates = this.collect(scope => scope.changelists.get(name));
    }

    const remote = this.collect(scope => scope.remoteChanges);
    if (remote.length && !this.remoteChanges) {
      this.remoteChanges = this.createGroup("remotechanges", "Remote Changes");
    }
    if (this.remoteChanges) {
      this.remoteChanges.repository = representative;
      this.remoteChanges.resourceStates = remote;
    }

    const ignoreOnStatusCount = configuration.get<string[]>(
      "sourceControl.ignoreOnStatusCount"
    );
    const countedChangelists = [...this.changelists]
      .filter(([name]) => !ignoreOnStatusCount.includes(name))
      .flatMap(([, group]) => group.resourceStates);
    this.sourceControl.count = uniqueResources([
      ...this.staged.resourceStates,
      ...this.changes.resourceStates,
      ...this.conflicts.resourceStates,
      ...(configuration.get<boolean>("sourceControl.countUnversioned", false)
        ? this.unversioned.resourceStates
        : []),
      ...countedChangelists
    ]).length;
    this.enableQuickDiff();
    this.sourceControl.acceptInputCommand = {
      command: "svn.commitStaged",
      title: "commit staged",
      arguments: [this.sourceControl]
    };
    this.sourceControl.statusBarCommands = this.statusBarCommands();
    this.changeEmitter.fire();
  }

  public provideOriginalResource(uri: Uri): ProviderResult<Uri> {
    return this.resolveRepository(uri)?.provideOriginalResource(uri);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposables of this.scopeDisposables.values()) {
      disposables.forEach(item => item.dispose());
    }
    this.scopeDisposables.clear();
    this.changelists.forEach(group => group.dispose());
    this.remoteChanges?.dispose();
    this.staged.dispose();
    this.changes.dispose();
    this.conflicts.dispose();
    this.unversioned.dispose();
    this.sourceControl.dispose();
    this.changeEmitter.dispose();
  }

  private createGroup(id: string, label: string): ISvnResourceGroup {
    const group = this.sourceControl.createResourceGroup(
      id,
      label
    ) as ISvnResourceGroup;
    group.hideWhenEmpty = true;
    return group;
  }

  private collect(
    select: (repository: Repository) => ISvnResourceGroup | undefined
  ): Resource[] {
    const resources: Resource[] = [];
    for (const scope of this.scopes) {
      for (const resource of select(scope)?.resourceStates ?? []) {
        if (
          isDescendant(scope.workspaceRoot, resource.resourceUri.fsPath) &&
          this.resolveRepository(resource.resourceUri) === scope
        ) {
          resources.push(resource);
        }
      }
    }
    return uniqueResources(resources);
  }

  private queueRefresh(): void {
    if (this.disposed || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.disposed) return;
      this.refresh();
    });
  }

  private enableQuickDiff(statusAccepted = false): void {
    if (
      !this.disposed &&
      !this.quickDiffEnabled &&
      (statusAccepted ||
        this.scopes.some(scope => !scope.isInitialStatusPending))
    ) {
      this.quickDiffEnabled = true;
      this.sourceControl.quickDiffProvider = this;
    }
  }

  private statusBarCommands(): Command[] {
    const commands: Command[] = [];
    const branch = this.commonBranch();
    if (branch) {
      commands.push({
        command: "svn.switchBranch",
        title: `$(git-branch) ${branch}`,
        tooltip: "Switch Branch...",
        arguments: [this.sourceControl]
      });
    }

    const busy = this.scopes.some(scope => !scope.operations.isIdle());
    const remote = this.remoteChanges?.resourceStates.length ?? 0;
    commands.push({
      command: busy ? "" : "svn.update",
      title: busy ? "$(sync~spin)" : `$(sync)${remote ? ` ${remote}↓` : ""}`,
      tooltip: busy ? "Running..." : "Update Revision",
      arguments: [this.sourceControl]
    });
    return commands;
  }

  private commonBranch(): string {
    const urls = this.scopes
      .map(scope => scope.repository.info.url)
      .filter(Boolean);
    if (!urls.length) return "";
    const parts = urls.map(url => url.split("/"));
    const common: string[] = [];
    for (let index = 0; index < parts[0].length; index += 1) {
      const value = parts[0][index];
      if (parts.every(candidate => candidate[index] === value)) {
        common.push(value);
      } else {
        break;
      }
    }
    const branch = getBranchName(common.join("/"));
    if (!branch) {
      const names = new Set(this.scopes.map(scope => scope.currentBranch));
      return names.size <= 1 ? ([...names][0] ?? "") : "Mixed locations";
    }
    return configuration.get<boolean>("layout.showFullName")
      ? branch.path
      : branch.name;
  }
}
