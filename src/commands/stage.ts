import * as path from "path";
import {
  commands,
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri
} from "vscode";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { SourceControlManager } from "../source_control_manager";
import { StagingCoordinator } from "../stagingCoordinator";
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

async function waitForSelectedWorkingCopiesIdle(
  staging: StagingCoordinator,
  resources: Resource[]
): Promise<boolean> {
  const sourceControlManager = await getSourceControlManager();
  const repositories = new Set<Repository>();

  for (const resource of resources) {
    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (repository) repositories.add(repository);
  }

  const results = await Promise.all(
    [...repositories].map(repository =>
      waitForWorkingCopyIdle(staging, repository)
    )
  );
  return results.every(Boolean);
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
      if (!folder) continue;

      for (const candidate of folder.group.resourceStates) {
        const candidateUri = candidate.resourceUri;
        if (!isPathInside(folder.uri.fsPath, candidateUri.fsPath)) continue;

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
    if (!(await waitForSelectedWorkingCopiesIdle(this.staging, selected))) {
      return;
    }
    const resources = await this.staging.validateStageSelection(selected);
    if (resources.length) {
      await this.staging.stage(resources);
    }
  }
}

export class Unstage extends BaseStagingCommand {
  constructor(staging: StagingCoordinator) {
    super("svn.unstage", staging);
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selected = await this.selectedResources(resourceStates);
    if (!(await waitForSelectedWorkingCopiesIdle(this.staging, selected))) {
      return;
    }
    const resources = await this.staging.validateUnstageSelection(selected);
    if (resources.length) {
      await this.staging.unstage(resources);
    }
  }
}

export class StageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.stageAll", { repository: true });
  }

  public async execute(repository: Repository) {
    if (!(await waitForWorkingCopyIdle(this.staging, repository))) {
      return;
    }
    const selected = this.staging.unstagedResourcesForWorkingCopy(repository);
    const resources = await this.staging.validateStageSelection(selected);
    if (resources.length) {
      await this.staging.stage(resources);
    }
  }
}

export class UnstageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.unstageAll", { repository: true });
  }

  public async execute(repository: Repository) {
    if (!(await waitForWorkingCopyIdle(this.staging, repository))) {
      return;
    }
    const selected = this.staging
      .stagedEntriesForWorkingCopy(repository)
      .map(entry => entry.resource);

    await this.staging.validateUnstageSelection(selected);
    await this.staging.unstageAll(repository);
  }
}
