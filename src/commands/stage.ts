import * as path from "path";
import { promises as fs } from "node:fs";
import {
  commands,
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri
} from "vscode";
import { Status } from "../common/types";
import { refreshStatusTargets } from "../incrementalStatus";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { SourceControlManager } from "../source_control_manager";
import { StagingCoordinator } from "../stagingCoordinator";
import {
  createStagingChangelist,
  parseStagingChangelist
} from "../stagingModel";
import {
  isUnversionedChildResource,
  UnversionedChildResource
} from "../unversionedDirectoryContents";
import { normalizePath } from "../util";
import { withWorkingCopyMutationLocks } from "../workingCopyMutationLock";
import { Command } from "./command";

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resourceUriFromScmArgument(value: unknown): Uri | undefined {
  if (!value || typeof value !== "object") return undefined;

  const direct = (value as { resourceUri?: unknown }).resourceUri;
  if (direct instanceof Uri) return direct;

  const element = (value as { element?: unknown }).element;
  if (element && typeof element === "object") {
    const nested = (element as { resourceUri?: unknown }).resourceUri;
    if (nested instanceof Uri) return nested;
  }

  return undefined;
}

function resourceFolderFromScmArgument(
  value: unknown
): { uri: Uri; group: SourceControlResourceGroup } | undefined {
  if (!value || typeof value !== "object") return undefined;

  const uri = (value as { uri?: unknown }).uri;
  const context = (value as { context?: unknown }).context;
  if (!(uri instanceof Uri) || !context || typeof context !== "object") {
    return undefined;
  }

  const group = context as SourceControlResourceGroup;
  if (!Array.isArray(group.resourceStates)) return undefined;
  return { uri, group };
}

function resourceGroupFromScmArgument(
  value: unknown
): SourceControlResourceGroup | undefined {
  if (!value || typeof value !== "object") return undefined;

  const resourceStates = (value as { resourceStates?: unknown }).resourceStates;
  if (!Array.isArray(resourceStates)) return undefined;
  return value as SourceControlResourceGroup;
}

async function getSourceControlManager(): Promise<SourceControlManager> {
  return (await commands.executeCommand(
    "svn.getSourceControlManager",
    ""
  )) as SourceControlManager;
}

async function waitForWorkingCopyIdle(
  staging: StagingCoordinator,
  repository: Repository
): Promise<boolean> {
  const results = await Promise.all(
    staging.repositoriesForWorkingCopy(repository).map(peer => peer.whenIdle())
  );
  return results.every(Boolean);
}

async function runWithSelectedWorkingCopiesLocked(
  staging: StagingCoordinator,
  resources: Resource[],
  run: () => Promise<void>
): Promise<void> {
  const sourceControlManager = await getSourceControlManager();
  const repositories = new Set<Repository>();

  for (const resource of resources) {
    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (repository) repositories.add(repository);
  }

  await withWorkingCopyMutationLocks(
    [...repositories].map(repository => repository.root),
    async () => {
      const results = await Promise.all(
        [...repositories].map(repository =>
          waitForWorkingCopyIdle(staging, repository)
        )
      );
      if (results.every(Boolean)) {
        await run();
      }
    }
  );
}

async function runWithWorkingCopyLocked(
  staging: StagingCoordinator,
  repository: Repository,
  run: () => Promise<void>
): Promise<void> {
  await withWorkingCopyMutationLocks([repository.root], async () => {
    if (await waitForWorkingCopyIdle(staging, repository)) {
      await run();
    }
  });
}

async function stageUnversionedChildren(
  resources: Resource[]
): Promise<Resource[]> {
  const sourceControlManager = await getSourceControlManager();
  const byRepository = new Map<Repository, UnversionedChildResource[]>();
  const regular: Resource[] = [];

  for (const resource of resources) {
    if (!isUnversionedChildResource(resource)) {
      regular.push(resource);
      continue;
    }

    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (!repository) continue;
    const selected = byRepository.get(repository) ?? [];
    selected.push(resource);
    byRepository.set(repository, selected);
  }

  for (const [repository, selected] of byRepository) {
    await refreshStatusTargets(repository, [
      ...new Set(selected.map(resource => resource.unversionedRoot))
    ]);

    const liveUnversionedRoots = new Set(
      repository.unversioned.resourceStates
        .filter(
          resource =>
            resource.type === Status.UNVERSIONED &&
            !isUnversionedChildResource(resource as Resource)
        )
        .map(resource => normalizePath(resource.resourceUri.fsPath))
    );
    const validated: UnversionedChildResource[] = [];

    for (const resource of selected) {
      const filePath = resource.resourceUri.fsPath;
      const current = repository.getResourceFromFile(resource.resourceUri);
      if (current && !isUnversionedChildResource(current)) {
        regular.push(current);
        continue;
      }

      if (
        !liveUnversionedRoots.has(normalizePath(resource.unversionedRoot)) ||
        !isPathInside(resource.unversionedRoot, filePath)
      ) {
        continue;
      }

      try {
        const stat = await fs.lstat(filePath);
        if (stat.isDirectory()) continue;
      } catch {
        continue;
      }
      validated.push(resource);
    }

    if (!validated.length) continue;
    const relativeFiles = validated.map(resource =>
      repository.repository.removeAbsolutePath(resource.resourceUri.fsPath)
    );

    await repository.repository.exec(["add", "--parents", ...relativeFiles]);

    const byStagingChangelist = new Map<string, string[]>();
    for (const resource of validated) {
      const createdDirectoryRelativeRoot = path.relative(
        repository.root,
        resource.unversionedRoot
      );
      const changelist = createStagingChangelist(
        undefined,
        true,
        createdDirectoryRelativeRoot || undefined
      );
      const paths = byStagingChangelist.get(changelist) ?? [];
      paths.push(resource.resourceUri.fsPath);
      byStagingChangelist.set(changelist, paths);
    }

    for (const [changelist, paths] of byStagingChangelist) {
      await repository.addChangelist(paths, changelist);
    }
  }

  return regular;
}

async function collectUnstageRefreshTargets(
  resources: Resource[]
): Promise<Map<Repository, string[]>> {
  const sourceControlManager = await getSourceControlManager();
  const byRepository = new Map<Repository, Map<string, string>>();

  for (const resource of resources) {
    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (!repository) continue;

    const targets = byRepository.get(repository) ?? new Map<string, string>();
    const add = (target: string) => targets.set(normalizePath(target), target);
    add(resource.resourceUri.fsPath);

    const changelist = repository.stagedChangelists.get(
      normalizePath(resource.resourceUri.fsPath)
    );
    const createdDirectoryRelativeRoot = changelist
      ? parseStagingChangelist(changelist)?.createdDirectoryRelativeRoot
      : undefined;
    if (createdDirectoryRelativeRoot) {
      add(path.resolve(repository.root, createdDirectoryRelativeRoot));
    }

    byRepository.set(repository, targets);
  }

  return new Map(
    [...byRepository].map(([repository, targets]) => [
      repository,
      [...targets.values()]
    ])
  );
}

async function refreshUnstageTargets(
  targetsByRepository: Map<Repository, string[]>
): Promise<void> {
  await Promise.all(
    [...targetsByRepository].map(([repository, targets]) =>
      refreshStatusTargets(repository, targets)
    )
  );
}

abstract class BaseStagingCommand extends Command {
  constructor(
    commandName: string,
    protected readonly staging: StagingCoordinator
  ) {
    super(commandName);
  }

  protected async selectedResources(
    resourceStates: SourceControlResourceState[]
  ): Promise<Resource[]> {
    if (!resourceStates.length) {
      return this.getResourceStates(resourceStates);
    }

    const sourceControlManager = await getSourceControlManager();
    const resources: Resource[] = [];

    for (const resourceState of resourceStates as unknown[]) {
      const uri = resourceUriFromScmArgument(resourceState);
      if (uri) {
        const repository = sourceControlManager.getRepository(uri);
        const resource = repository?.getResourceFromFile(uri);
        if (resource) resources.push(resource);
        continue;
      }

      const folder = resourceFolderFromScmArgument(resourceState);
      if (folder) {
        const folderResources: Resource[] = [];
        for (const candidate of folder.group.resourceStates) {
          const candidateUri = candidate.resourceUri;
          if (!isPathInside(folder.uri.fsPath, candidateUri.fsPath)) continue;

          const repository = sourceControlManager.getRepository(candidateUri);
          const resource = repository?.getResourceFromFile(candidateUri);
          if (resource) folderResources.push(resource);
        }
        const root = folderResources.find(
          resource =>
            resource.resourceUri.fsPath === folder.uri.fsPath &&
            resource.type === Status.UNVERSIONED &&
            !isUnversionedChildResource(resource)
        );
        if (root) {
          resources.push(root);
        } else {
          resources.push(...folderResources);
        }
        continue;
      }

      const group = resourceGroupFromScmArgument(resourceState);
      if (!group) continue;
      for (const candidate of group.resourceStates) {
        if (
          candidate instanceof Resource &&
          isUnversionedChildResource(candidate)
        ) {
          continue;
        }
        const candidateUri = candidate.resourceUri;
        const repository = sourceControlManager.getRepository(candidateUri);
        const resource = repository?.getResourceFromFile(candidateUri);
        if (resource) resources.push(resource);
      }
    }

    return resources;
  }
}

export class Stage extends BaseStagingCommand {
  constructor(staging: StagingCoordinator) {
    super("svn.stage", staging);
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selected = await this.selectedResources(resourceStates);
    await runWithSelectedWorkingCopiesLocked(
      this.staging,
      selected,
      async () => {
        const regular = await stageUnversionedChildren(selected);
        const resources = await this.staging.validateStageSelection(regular);
        if (resources.length) {
          await this.staging.stage(resources);
        }
      }
    );
  }
}

export class Unstage extends BaseStagingCommand {
  constructor(staging: StagingCoordinator) {
    super("svn.unstage", staging);
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selected = await this.selectedResources(resourceStates);
    await runWithSelectedWorkingCopiesLocked(
      this.staging,
      selected,
      async () => {
        const resources = await this.staging.validateUnstageSelection(selected);
        if (resources.length) {
          const refreshTargets = await collectUnstageRefreshTargets(resources);
          await this.staging.unstage(resources);
          await refreshUnstageTargets(refreshTargets);
        }
      }
    );
  }
}

export class StageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.stageAll", { repository: true });
  }

  public async execute(repository: Repository) {
    await runWithWorkingCopyLocked(this.staging, repository, async () => {
      const selected = this.staging
        .unstagedResourcesForWorkingCopy(repository)
        .filter(resource => !isUnversionedChildResource(resource));
      const resources = await this.staging.validateStageSelection(selected);
      if (resources.length) {
        await this.staging.stage(resources);
      }
    });
  }
}

export class UnstageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.unstageAll", { repository: true });
  }

  public async execute(repository: Repository) {
    await runWithWorkingCopyLocked(this.staging, repository, async () => {
      const selected = this.staging
        .stagedEntriesForWorkingCopy(repository)
        .map(entry => entry.resource);
      const refreshTargets = await collectUnstageRefreshTargets(selected);

      await this.staging.validateUnstageSelection(selected);
      await this.staging.unstageAll(repository);
      await refreshUnstageTargets(refreshTargets);
    });
  }
}
