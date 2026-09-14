import * as path from "path";
import { Disposable, SourceControlResourceGroup, Uri, window } from "vscode";
import { ISvnResourceGroup, Status } from "./common/types";
import { lstat } from "./fs";
import { refreshStatusTargets } from "./incrementalStatus";
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
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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
      sourceControlManager.onDidOpenRepository(repository =>
        this.attach(repository)
      ),
      sourceControlManager.onDidCloseRepository(repository =>
        this.detach(repository)
      )
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
    const seen = new Set<string>();
    const peers = [...this.repositoriesForWorkingCopy(repository)].sort(
      (left, right) => right.workspaceRoot.length - left.workspaceRoot.length
    );

    for (const peer of peers) {
      for (const status of peer.getStatusSnapshot() ?? []) {
        if (!status.changelist || !isStagingChangelist(status.changelist)) {
          continue;
        }

        const filePath = path.isAbsolute(status.path)
          ? status.path
          : path.resolve(peer.workspaceRoot, status.path);
        if (!isPathInside(peer.workspaceRoot, filePath)) continue;

        const key = normalizePath(filePath);
        if (seen.has(key)) continue;
        seen.add(key);

        const renameResourceUri = status.rename
          ? Uri.file(
              path.isAbsolute(status.rename)
                ? status.rename
                : path.resolve(peer.workspaceRoot, status.rename)
            )
          : undefined;
        entries.push({
          repository: peer,
          resource: new Resource(
            Uri.file(filePath),
            status.status,
            renameResourceUri,
            status.props
          ),
          changelist: status.changelist
        });
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
      resources.push(
        ...peer.changes.resourceStates,
        ...peer.unversioned.resourceStates
      );
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

  public async validateStageSelection(
    resources: Resource[]
  ): Promise<Resource[]> {
    return this.validateSelection(resources, false);
  }

  public async validateUnstageSelection(
    resources: Resource[]
  ): Promise<Resource[]> {
    return this.validateSelection(resources, true);
  }

  private async validateSelection(
    resources: Resource[],
    stagedOnly: boolean
  ): Promise<Resource[]> {
    const byRepository = new Map<Repository, Resource[]>();
    for (const resource of uniqueResources(resources)) {
      const repository = this.sourceControlManager.getRepository(
        resource.resourceUri
      );
      if (!repository) continue;
      const selected = byRepository.get(repository) ?? [];
      selected.push(resource);
      byRepository.set(repository, selected);
    }

    const validated: Resource[] = [];
    for (const [repository, selected] of byRepository) {
      if (await this.needsFullStatus(selected)) {
        await repository.fullStatus();
      } else {
        await refreshStatusTargets(
          repository,
          selected.map(resource => resource.resourceUri.fsPath)
        );
      }
      const staged = this.states.get(repository)?.group.resourceStates ?? [];

      for (const original of selected) {
        const filePath = original.resourceUri.fsPath;
        if (!stagedOnly && repository.isPreviewResource(original)) {
          try {
            if ((await lstat(filePath)).isDirectory()) continue;
          } catch {
            continue;
          }
        }

        const stagedResource = staged.find(resource =>
          samePath(resource.resourceUri.fsPath, filePath)
        );
        if (stagedOnly) {
          if (stagedResource) validated.push(stagedResource as Resource);
          continue;
        }
        if (stagedResource) continue;

        const current = this.findResource(repository, filePath);
        if (current && current.type !== Status.CONFLICTED) {
          validated.push(current);
        }
      }
    }

    return uniqueResources(validated);
  }

  private async needsFullStatus(resources: Resource[]): Promise<boolean> {
    for (const resource of resources) {
      try {
        if ((await lstat(resource.resourceUri.fsPath)).isSymbolicLink()) {
          return true;
        }
      } catch {
        // Missing paths are validated by SVN status itself.
      }
    }
    return false;
  }

  private async refreshProjectionsContainingPaths(
    repository: Repository,
    resources: Resource[],
    forceFullStatus: boolean = false
  ): Promise<void> {
    const filePaths = resources.map(resource => resource.resourceUri.fsPath);
    const peers = this.repositoriesForWorkingCopy(repository).filter(
      peer =>
        peer !== repository &&
        filePaths.some(filePath => isPathInside(peer.workspaceRoot, filePath))
    );
    await Promise.all(
      peers.map(peer =>
        forceFullStatus
          ? peer.fullStatus()
          : refreshStatusTargets(
              peer,
              filePaths.filter(filePath =>
                isPathInside(peer.workspaceRoot, filePath)
              )
            )
      )
    );
  }

  public async stage(resources: Resource[]): Promise<void> {
    const byRepository = new Map<Repository, Resource[]>();
    for (const resource of uniqueResources(resources)) {
      const repository = this.sourceControlManager.getRepository(
        resource.resourceUri
      );
      if (!repository) continue;
      const list = byRepository.get(repository) ?? [];
      list.push(resource);
      byRepository.set(repository, list);
    }

    for (const [repository, selected] of byRepository) {
      const forceFullStatus = await this.needsFullStatus(selected);
      await this.stageInRepository(repository, selected);
      if (forceFullStatus) {
        await repository.fullStatus();
      }
      await this.refreshProjectionsContainingPaths(
        repository,
        selected,
        forceFullStatus
      );
    }
  }

  public async stageAll(repository: Repository): Promise<void> {
    await this.stage(this.unstagedResourcesForWorkingCopy(repository));
  }

  public async unstage(resources: Resource[]): Promise<void> {
    const byRepository = new Map<Repository, Resource[]>();
    for (const resource of uniqueResources(resources)) {
      const repository = this.sourceControlManager.getRepository(
        resource.resourceUri
      );
      if (!repository) continue;
      const list = byRepository.get(repository) ?? [];
      list.push(resource);
      byRepository.set(repository, list);
    }

    for (const [repository, selected] of byRepository) {
      const state = this.states.get(repository);
      if (!state) continue;

      const grouped = new Map<string, Resource[]>();
      for (const resource of selected) {
        const key = normalizePath(resource.resourceUri.fsPath);
        const stagingChangelist = state.metadataByPath.get(key);
        if (!stagingChangelist) continue;
        const resources = grouped.get(stagingChangelist) ?? [];
        resources.push(resource);
        grouped.set(stagingChangelist, resources);
      }

      const forceFullStatus = await this.needsFullStatus(selected);
      for (const [stagingChangelist, resources] of grouped) {
        const metadata = parseStagingChangelist(stagingChangelist);
        if (!metadata) continue;
        await this.restoreDestination(repository, resources, metadata);
      }
      if (forceFullStatus) {
        await repository.fullStatus();
      }
      await this.refreshProjectionsContainingPaths(
        repository,
        selected,
        forceFullStatus
      );
    }
  }

  public async unstageAll(repository: Repository): Promise<void> {
    const byRepository = new Map<Repository, Map<string, Resource[]>>();
    for (const entry of this.stagedEntriesForWorkingCopy(repository)) {
      const byChangelist = byRepository.get(entry.repository) ?? new Map();
      const resources = byChangelist.get(entry.changelist) ?? [];
      resources.push(entry.resource);
      byChangelist.set(entry.changelist, resources);
      byRepository.set(entry.repository, byChangelist);
    }

    for (const [owner, byChangelist] of byRepository) {
      const refreshed: Resource[] = [];
      for (const [stagingChangelist, resources] of byChangelist) {
        const metadata = parseStagingChangelist(stagingChangelist);
        if (!metadata) continue;
        await this.restoreDestination(owner, resources, metadata);
        refreshed.push(...resources);
      }
      if (refreshed.length) {
        await this.refreshProjectionsContainingPaths(owner, refreshed);
      }
    }
  }

  public findResource(
    repository: Repository,
    filePath: string
  ): Resource | undefined {
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

  public async finalizeCommitted(
    entries: Array<{
      repository: Repository;
      resource: Resource;
      changelist?: string;
    }>
  ): Promise<void> {
    const grouped = new Map<Repository, Map<string | undefined, string[]>>();

    for (const { repository, resource, changelist } of entries) {
      // A successfully committed deletion has no working-copy node whose
      // changelist can be restored. A sibling projection may still expose its
      // pre-commit metadata until that projection refreshes.
      if (resource.type === Status.DELETED) continue;

      const key = normalizePath(resource.resourceUri.fsPath);
      const stagingChangelist =
        changelist ??
        this.states.get(repository)?.metadataByPath.get(key) ??
        repository.stagedChangelists.get(key);
      if (!stagingChangelist || !isStagingChangelist(stagingChangelist)) {
        continue;
      }

      const metadata = parseStagingChangelist(stagingChangelist);
      if (!metadata) continue;

      const destinations = grouped.get(repository) ?? new Map();
      const paths = destinations.get(metadata.originalChangelist) ?? [];
      paths.push(resource.resourceUri.fsPath);
      destinations.set(metadata.originalChangelist, paths);
      grouped.set(repository, destinations);
    }

    for (const [repository, destinations] of grouped) {
      for (const [destination, paths] of destinations) {
        if (destination) {
          await repository.addChangelist(paths, destination);
        } else {
          await repository.removeChangelist(paths);
        }
      }
    }
  }

  private attach(repository: Repository): void {
    if (this.states.has(repository)) return;

    const group = repository.staged;
    if (!group) return;

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
      repository.onDidRebuildStatusProjection(() => this.reconcile(repository))
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
    state.group.resourceStates = [];
    repository.stagedChangelists.clear();
    this.states.delete(repository);
  }

  private reconcile(repository: Repository): void {
    const state = this.states.get(repository);
    if (!state) return;

    repository.changes.repository = repository;
    repository.conflicts.repository = repository;
    repository.unversioned.repository = repository;
    for (const group of repository.changelists.values()) {
      group.repository = repository;
    }

    const staged: Resource[] = [];
    state.metadataByPath.clear();
    repository.stagedChangelists.clear();

    for (const [changelist, group] of repository.changelists) {
      if (!isStagingChangelist(changelist)) continue;
      for (const resource of group.resourceStates) {
        staged.push(resource);
        const key = normalizePath(resource.resourceUri.fsPath);
        state.metadataByPath.set(key, changelist);
        repository.stagedChangelists.set(key, changelist);
      }
      group.resourceStates = [];
    }

    state.group.resourceStates = uniqueResources(staged);
  }

  private createdDirectoryRelativeRootForPath(
    repository: Repository,
    filePath: string
  ): string | undefined {
    const changelists = new Set<string>([
      ...(this.states.get(repository)?.metadataByPath.values() ?? []),
      ...repository.stagedChangelists.values()
    ]);
    let best: { relative: string; absolute: string } | undefined;

    for (const changelist of changelists) {
      const relative =
        parseStagingChangelist(changelist)?.createdDirectoryRelativeRoot;
      if (!relative) continue;

      const absolute = path.resolve(repository.root, relative);
      if (
        !isPathInside(repository.root, absolute) ||
        !isPathInside(absolute, filePath)
      ) {
        continue;
      }

      if (
        !best ||
        normalizePath(absolute).length > normalizePath(best.absolute).length
      ) {
        best = { relative, absolute };
      }
    }

    return best?.relative;
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
    let skippedDirectories = 0;

    for (const resource of selected) {
      const current = this.currentChangelist(repository, resource);
      if (current && isStagingChangelist(current)) continue;
      if (resource.type === Status.UNVERSIONED) {
        unversioned.push(resource);
        continue;
      }

      if (await this.isDirectoryResource(repository, resource)) {
        skippedDirectories += 1;
        continue;
      }
      regular.push(resource);
    }

    if (skippedDirectories) {
      void window.showWarningMessage(
        "SVN staging currently supports file changes only. Directory-only changes remain in Changes and can be committed with Commit All."
      );
    }

    if (unversioned.length) {
      const files: string[] = [];
      const directories: string[] = [];
      for (const resource of unversioned) {
        try {
          if ((await lstat(resource.resourceUri.fsPath)).isDirectory()) {
            directories.push(resource.resourceUri.fsPath);
          } else {
            files.push(resource.resourceUri.fsPath);
          }
        } catch {
          files.push(resource.resourceUri.fsPath);
        }
      }

      if (files.length) {
        const byDestination = new Map<string, string[]>();
        for (const file of files) {
          const destination = createStagingChangelist(
            undefined,
            true,
            this.createdDirectoryRelativeRootForPath(repository, file)
          );
          const paths = byDestination.get(destination) ?? [];
          paths.push(file);
          byDestination.set(destination, paths);
        }

        await repository.addFiles(files);
        for (const [destination, paths] of byDestination) {
          await repository.addChangelist(paths, destination);
        }
      }

      for (const directory of directories) {
        await repository.addFiles([directory]);
        let descendants = this.resourcesUnderPath(repository, directory).filter(
          resource => resource.type === Status.ADDED
        );
        await this.cleanupHiddenDirectoryAdditions(
          repository,
          directory,
          descendants
        );
        descendants = this.resourcesUnderPath(repository, directory).filter(
          resource => resource.type === Status.ADDED
        );
        const fileDescendants: string[] = [];
        for (const resource of descendants) {
          try {
            if (!(await lstat(resource.resourceUri.fsPath)).isDirectory()) {
              fileDescendants.push(resource.resourceUri.fsPath);
            }
          } catch {
            fileDescendants.push(resource.resourceUri.fsPath);
          }
        }
        if (fileDescendants.length) {
          await repository.addChangelist(
            fileDescendants,
            createStagingChangelist(
              undefined,
              true,
              path.relative(repository.root, directory)
            )
          );
        } else {
          await repository.revert([directory], "infinity");
          void window.showWarningMessage(
            "Empty directories cannot be staged because SVN changelists apply only to files."
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

  private async isDirectoryResource(
    repository: Repository,
    resource: Resource
  ): Promise<boolean> {
    try {
      return (await lstat(resource.resourceUri.fsPath)).isDirectory();
    } catch {
      try {
        return (
          (await repository.info(resource.resourceUri.fsPath)).kind === "dir"
        );
      } catch {
        return false;
      }
    }
  }

  private resourcesUnderPath(
    repository: Repository,
    parent: string
  ): Resource[] {
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

  private async cleanupHiddenDirectoryAdditions(
    repository: Repository,
    directory: string,
    visibleAdded: Resource[]
  ): Promise<void> {
    const visible = new Set<string>();
    const requiredDirectories = new Set<string>();

    for (const resource of visibleAdded) {
      const resourcePath = resource.resourceUri.fsPath;
      visible.add(normalizePath(resourcePath));

      let parent = path.dirname(resourcePath);
      while (isPathInside(directory, parent)) {
        requiredDirectories.add(normalizePath(parent));
        if (samePath(parent, directory)) break;
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }

    const statuses = await repository.repository.getStatus({
      includeIgnored: true,
      includeExternals: false,
      forceFull: true
    });
    const hidden = statuses
      .filter(status => status.status === Status.ADDED)
      .map(status =>
        path.isAbsolute(status.path)
          ? status.path
          : path.resolve(repository.workspaceRoot, status.path)
      )
      .filter(candidate => isPathInside(directory, candidate))
      .filter(candidate => {
        const key = normalizePath(candidate);
        return !visible.has(key) && !requiredDirectories.has(key);
      })
      .sort((left, right) => left.length - right.length);

    const roots: string[] = [];
    for (const candidate of hidden) {
      if (!roots.some(root => isPathInside(root, candidate))) {
        roots.push(candidate);
      }
    }

    for (const hiddenRoot of roots) {
      let depth: "empty" | "infinity" = "empty";
      try {
        if ((await lstat(hiddenRoot)).isDirectory()) {
          depth = "infinity";
        }
      } catch {
        // SVN status remains authoritative when the filesystem entry vanished.
      }
      await repository.revert([hiddenRoot], depth);
    }
  }

  private snapshotAddedPaths(repository: Repository): string[] {
    return (repository.getStatusSnapshot() ?? [])
      .filter(status => status.status === Status.ADDED)
      .map(status =>
        path.isAbsolute(status.path)
          ? status.path
          : path.resolve(repository.workspaceRoot, status.path)
      );
  }

  private async addedAncestorDirectoriesForUnstage(
    repository: Repository,
    paths: string[],
    createdDirectoryRelativeRoot: string
  ): Promise<string[]> {
    const createdDirectoryRoot = path.resolve(
      repository.root,
      createdDirectoryRelativeRoot
    );
    if (!isPathInside(repository.root, createdDirectoryRoot)) {
      return [];
    }

    const selected = new Set(paths.map(normalizePath));
    const added = this.snapshotAddedPaths(repository)
      .filter(candidate => isPathInside(createdDirectoryRoot, candidate))
      .map(normalizePath);
    const addedSet = new Set(added);
    const candidates = new Set<string>();

    for (const filePath of paths) {
      let directory = path.dirname(filePath);
      while (
        directory !== path.dirname(directory) &&
        isPathInside(createdDirectoryRoot, directory)
      ) {
        const key = normalizePath(directory);
        if (addedSet.has(key)) {
          candidates.add(key);
        }
        if (samePath(directory, createdDirectoryRoot)) {
          break;
        }
        directory = path.dirname(directory);
      }
    }

    return [...candidates]
      .filter(
        directory =>
          !added.some(
            resourcePath =>
              resourcePath !== directory &&
              isPathInside(directory, resourcePath) &&
              !selected.has(resourcePath) &&
              !candidates.has(resourcePath)
          )
      )
      .sort((left, right) => right.length - left.length);
  }

  private async restoreDestination(
    repository: Repository,
    resources: Resource[],
    metadata: StagingChangelistMetadata
  ): Promise<void> {
    const paths = resources.map(resource => resource.resourceUri.fsPath);
    if (metadata.originalChangelist) {
      await repository.addChangelist(paths, metadata.originalChangelist);
      return;
    }

    await repository.removeChangelist(paths);
    if (!metadata.wasUnversioned) return;

    const selected = new Set(paths.map(normalizePath));
    const addedPaths = this.snapshotAddedPaths(repository).filter(candidate =>
      selected.has(normalizePath(candidate))
    );
    if (!addedPaths.length) return;

    const addedDirectories = metadata.createdDirectoryRelativeRoot
      ? await this.addedAncestorDirectoriesForUnstage(
          repository,
          addedPaths,
          metadata.createdDirectoryRelativeRoot
        )
      : [];

    await repository.revert(addedPaths, "empty");
    for (const directory of addedDirectories) {
      await repository.revert([directory], "empty");
    }
  }
}
