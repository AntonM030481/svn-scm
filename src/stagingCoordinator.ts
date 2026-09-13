import * as path from "path";
import { Disposable, SourceControlResourceGroup } from "vscode";
import { ISvnResourceGroup, Status } from "./common/types";
import { stat } from "./fs";
import { configuration } from "./helpers/configuration";
import { Repository } from "./repository";
import { Resource } from "./resource";
import { SourceControlManager } from "./source_control_manager";
import {
  createStagingChangelist,
  isStagingChangelist,
  normalizeWorkingCopyRoot,
  parseStagingChangelist,
  StagingChangelistMetadata
} from "./stagingModel";
import { normalizePath } from "./util";

interface RepositoryStagingState {
  group: ISvnResourceGroup;
  metadataByPath: Map<string, string>;
  disposables: Disposable[];
  previousAcceptInputCommand: unknown;
}

interface StagedEntry {
  repository: Repository;
  resource: Resource;
  changelist: string;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueResources(resources: Resource[]): Resource[] {
  const result = new Map<string, Resource>();
  for (const resource of resources) {
    result.set(normalizePath(resource.resourceUri.fsPath), resource);
  }
  return [...result.values()];
}

export class StagingCoordinator implements Disposable {
  private readonly states = new Map<Repository, RepositoryStagingState>();
  private readonly disposables: Disposable[] = [];

  constructor(private readonly sourceControlManager: SourceControlManager) {
    for (const repository of sourceControlManager.repositories) {
      this.attach(repository);
    }

    this.disposables.push(
      sourceControlManager.onDidOpenRepository(repository => this.attach(repository)),
      sourceControlManager.onDidCloseRepository(repository => this.detach(repository))
    );
  }

  public dispose(): void {
    for (const repository of [...this.states.keys()]) {
      this.detach(repository);
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  public repositoriesForWorkingCopy(repository: Repository): Repository[] {
    const key = normalizeWorkingCopyRoot(repository.root);
    return this.sourceControlManager.repositories.filter(
      candidate => normalizeWorkingCopyRoot(candidate.root) === key
    );
  }

  public stagedEntriesForWorkingCopy(repository: Repository): StagedEntry[] {
    const entries: StagedEntry[] = [];
    for (const peer of this.repositoriesForWorkingCopy(repository)) {
      const state = this.states.get(peer);
      if (!state) continue;
      for (const resource of state.group.resourceStates) {
        const changelist = state.metadataByPath.get(
          normalizePath(resource.resourceUri.fsPath)
        );
        if (changelist) {
          entries.push({ repository: peer, resource, changelist });
        }
      }
    }
    return entries;
  }

  public unstagedResourcesForWorkingCopy(repository: Repository): Resource[] {
    const ignoredChangelists = new Set(
      configuration.get<string[]>("sourceControl.ignoreOnCommit", [])
    );
    const resources: Resource[] = [];

    for (const peer of this.repositoriesForWorkingCopy(repository)) {
      resources.push(...peer.changes.resourceStates, ...peer.unversioned.resourceStates);
      for (const [changelist, group] of peer.changelists) {
        if (
          !isStagingChangelist(changelist) &&
          !ignoredChangelists.has(changelist)
        ) {
          resources.push(...group.resourceStates);
        }
      }
    }

    return uniqueResources(resources).filter(
      resource => resource.type !== Status.CONFLICTED
    );
  }

  public allCommittableEntriesForWorkingCopy(
    repository: Repository
  ): Array<{ repository: Repository; resource: Resource }> {
    const ignoredChangelists = new Set(
      configuration.get<string[]>("sourceControl.ignoreOnCommit", [])
    );
    const entries: Array<{ repository: Repository; resource: Resource }> = [];
    const seen = new Set<string>();

    for (const peer of this.repositoriesForWorkingCopy(repository)) {
      const add = (resource: Resource) => {
        const key = normalizePath(resource.resourceUri.fsPath);
        if (!seen.has(key) && resource.type !== Status.CONFLICTED) {
          seen.add(key);
          entries.push({ repository: peer, resource });
        }
      };

      peer.changes.resourceStates.forEach(add);
      const staged = this.states.get(peer)?.group.resourceStates ?? [];
      staged.forEach(add);
      for (const [changelist, group] of peer.changelists) {
        if (
          !isStagingChangelist(changelist) &&
          !ignoredChangelists.has(changelist)
        ) {
          group.resourceStates.forEach(add);
        }
      }
    }

    return entries;
  }

  public async stage(resources: Resource[]): Promise<void> {
    const byRepository = new Map<Repository, Resource[]>();
    for (const resource of uniqueResources(resources)) {
      const repository = this.sourceControlManager.getRepository(resource.resourceUri);
      if (!repository) continue;
      const list = byRepository.get(repository) ?? [];
      list.push(resource);
      byRepository.set(repository, list);
    }

    for (const [repository, selected] of byRepository) {
      await this.stageInRepository(repository, selected);
    }
    this.reconcileWorkingCopies(byRepository.keys());
  }

  public async stageAll(repository: Repository): Promise<void> {
    await this.stage(this.unstagedResourcesForWorkingCopy(repository));
  }

  public async unstage(resources: Resource[]): Promise<void> {
    const byRepository = new Map<Repository, Resource[]>();
    for (const resource of uniqueResources(resources)) {
      const repository = this.sourceControlManager.getRepository(resource.resourceUri);
      if (!repository) continue;
      const list = byRepository.get(repository) ?? [];
      list.push(resource);
      byRepository.set(repository, list);
    }

    for (const [repository, selected] of byRepository) {
      const state = this.states.get(repository);
      if (!state) continue;

      const grouped = new Map<string, string[]>();
      for (const resource of selected) {
        const key = normalizePath(resource.resourceUri.fsPath);
        const stagingChangelist = state.metadataByPath.get(key);
        if (!stagingChangelist) continue;
        const paths = grouped.get(stagingChangelist) ?? [];
        paths.push(resource.resourceUri.fsPath);
        grouped.set(stagingChangelist, paths);
      }

      for (const [stagingChangelist, paths] of grouped) {
        const metadata = parseStagingChangelist(stagingChangelist);
        if (!metadata) continue;
        await this.restoreDestination(repository, paths, metadata);
      }
    }
    this.reconcileWorkingCopies(byRepository.keys());
  }

  public async unstageAll(repository: Repository): Promise<void> {
    await this.unstage(
      this.stagedEntriesForWorkingCopy(repository).map(entry => entry.resource)
    );
  }

  public findResource(repository: Repository, filePath: string): Resource | undefined {
    const state = this.states.get(repository);
    const groups: SourceControlResourceGroup[] = [
      repository.changes,
      repository.conflicts,
      repository.unversioned,
      ...(state ? [state.group] : []),
      ...repository.changelists.values()
    ];
    for (const group of groups) {
      const resource = group.resourceStates.find(resource =>
        samePath(resource.resourceUri.fsPath, filePath)
      ) as Resource | undefined;
      if (resource) return resource;
    }
    return undefined;
  }

  public async refreshWorkingCopy(repository: Repository): Promise<void> {
    await Promise.allSettled(
      this.repositoriesForWorkingCopy(repository).map(peer => peer.status())
    );
  }

  public clearInputBoxes(repository: Repository): void {
    for (const peer of this.repositoriesForWorkingCopy(repository)) {
      peer.inputBox.value = "";
    }
  }

  private attach(repository: Repository): void {
    if (this.states.has(repository)) return;

    const group = repository.sourceControl.createResourceGroup(
      "staged",
      "Staged Changes"
    ) as ISvnResourceGroup;
    group.hideWhenEmpty = true;

    const state: RepositoryStagingState = {
      group,
      metadataByPath: new Map(),
      disposables: [],
      previousAcceptInputCommand: repository.sourceControl.acceptInputCommand
    };
    this.states.set(repository, state);

    repository.sourceControl.acceptInputCommand = {
      command: "svn.commitStaged",
      title: "Commit Staged",
      arguments: [repository.sourceControl]
    };

    state.disposables.push(
      group,
      repository.onDidChangeStatus(() => this.reconcile(repository))
    );
    this.reconcile(repository);
  }

  private detach(repository: Repository): void {
    const state = this.states.get(repository);
    if (!state) return;

    const currentCommand = repository.sourceControl.acceptInputCommand;
    if (currentCommand?.command === "svn.commitStaged") {
      repository.sourceControl.acceptInputCommand =
        state.previousAcceptInputCommand as typeof currentCommand;
    }

    while (state.disposables.length) {
      state.disposables.pop()?.dispose();
    }
    this.states.delete(repository);
  }

  private reconcile(repository: Repository): void {
    const state = this.states.get(repository);
    if (!state) return;

    const staged: Resource[] = [];
    state.metadataByPath.clear();

    for (const [changelist, group] of repository.changelists) {
      if (!isStagingChangelist(changelist)) continue;
      for (const resource of group.resourceStates) {
        staged.push(resource);
        state.metadataByPath.set(
          normalizePath(resource.resourceUri.fsPath),
          changelist
        );
      }
      group.resourceStates = [];
    }

    state.group.resourceStates = uniqueResources(staged);
  }

  private reconcileWorkingCopies(repositories: Iterable<Repository>): void {
    const roots = new Set<string>();
    for (const repository of repositories) {
      roots.add(normalizeWorkingCopyRoot(repository.root));
    }
    for (const repository of this.sourceControlManager.repositories) {
      if (roots.has(normalizeWorkingCopyRoot(repository.root))) {
        this.reconcile(repository);
      }
    }
  }

  private currentChangelist(
    repository: Repository,
    resource: Resource
  ): string | undefined {
    const key = normalizePath(resource.resourceUri.fsPath);
    const internal = this.states.get(repository)?.metadataByPath.get(key);
    if (internal) return internal;

    for (const [changelist, group] of repository.changelists) {
      if (
        !isStagingChangelist(changelist) &&
        group.resourceStates.some(item =>
          samePath(item.resourceUri.fsPath, resource.resourceUri.fsPath)
        )
      ) {
        return changelist;
      }
    }
    return undefined;
  }

  private async stageInRepository(
    repository: Repository,
    selected: Resource[]
  ): Promise<void> {
    const regular: Resource[] = [];
    const unversioned: Resource[] = [];

    for (const resource of selected) {
      const current = this.currentChangelist(repository, resource);
      if (current && isStagingChangelist(current)) continue;
      if (resource.type === Status.UNVERSIONED) unversioned.push(resource);
      else regular.push(resource);
    }

    if (unversioned.length) {
      const files: string[] = [];
      const directories: string[] = [];
      for (const resource of unversioned) {
        try {
          if ((await stat(resource.resourceUri.fsPath)).isDirectory()) {
            directories.push(resource.resourceUri.fsPath);
          } else {
            files.push(resource.resourceUri.fsPath);
          }
        } catch {
          files.push(resource.resourceUri.fsPath);
        }
      }

      if (files.length) {
        await repository.addFiles(files);
        await repository.addChangelist(
          files,
          createStagingChangelist(undefined, true)
        );
      }

      for (const directory of directories) {
        await repository.addFiles([directory]);
        const descendants = this.resourcesUnderPath(repository, directory).filter(
          resource => resource.type === Status.ADDED
        );
        const fileDescendants: string[] = [];
        for (const resource of descendants) {
          try {
            if (!(await stat(resource.resourceUri.fsPath)).isDirectory()) {
              fileDescendants.push(resource.resourceUri.fsPath);
            }
          } catch {
            fileDescendants.push(resource.resourceUri.fsPath);
          }
        }
        if (fileDescendants.length) {
          await repository.addChangelist(
            fileDescendants,
            createStagingChangelist(undefined, true)
          );
        }
      }
    }

    const byDestination = new Map<string, string[]>();
    for (const resource of regular) {
      const original = this.currentChangelist(repository, resource);
      const destination = createStagingChangelist(original);
      const list = byDestination.get(destination) ?? [];
      list.push(resource.resourceUri.fsPath);
      byDestination.set(destination, list);
    }

    for (const [destination, files] of byDestination) {
      await repository.addChangelist(files, destination);
    }
  }

  private resourcesUnderPath(repository: Repository, parent: string): Resource[] {
    const resources: Resource[] = [
      ...repository.changes.resourceStates,
      ...repository.unversioned.resourceStates
    ];
    for (const group of repository.changelists.values()) {
      resources.push(...group.resourceStates);
    }
    const staged = this.states.get(repository)?.group.resourceStates ?? [];
    resources.push(...staged);
    return uniqueResources(resources).filter(resource =>
      isPathInside(parent, resource.resourceUri.fsPath)
    );
  }

  private async restoreDestination(
    repository: Repository,
    paths: string[],
    metadata: StagingChangelistMetadata
  ): Promise<void> {
    if (metadata.originalChangelist) {
      await repository.addChangelist(paths, metadata.originalChangelist);
      return;
    }

    await repository.removeChangelist(paths);
    if (metadata.wasUnversioned) {
      await repository.revert(paths, "empty");
    }
  }
}
