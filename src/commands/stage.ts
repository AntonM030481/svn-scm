import { commands, SourceControlResourceState, Uri } from "vscode";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { SourceControlManager } from "../source_control_manager";
import { StagingCoordinator } from "../stagingCoordinator";
import { Command } from "./command";

function resourceUriFromScmArgument(value: unknown): Uri | undefined {
  if (!value || typeof value !== "object") return undefined;

  const direct = (value as { resourceUri?: unknown }).resourceUri;
  if (direct instanceof Uri) return direct;

  // In SCM tree view VS Code sets the inline action context to an
  // IResourceNode wrapper. The actual SourceControlResourceState is stored in
  // `element`, while list view passes the resource directly.
  const element = (value as { element?: unknown }).element;
  if (element && typeof element === "object") {
    const nested = (element as { resourceUri?: unknown }).resourceUri;
    if (nested instanceof Uri) return nested;
  }

  return undefined;
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

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;
    const resources: Resource[] = [];

    for (const resourceState of resourceStates as unknown[]) {
      const uri = resourceUriFromScmArgument(resourceState);
      if (!uri) continue;

      const repository = sourceControlManager.getRepository(uri);
      const resource = repository?.getResourceFromFile(uri);
      if (resource) resources.push(resource);
    }

    return resources;
  }
}

async function ensureWorkingCopyLiveStatus(
  staging: StagingCoordinator,
  repository: Repository
): Promise<void> {
  await Promise.all(
    staging
      .repositoriesForWorkingCopy(repository)
      .map(peer => peer.fullStatus())
  );
}

export class Stage extends BaseStagingCommand {
  constructor(staging: StagingCoordinator) {
    super("svn.stage", staging);
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const selected = await this.selectedResources(resourceStates);
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
    await ensureWorkingCopyLiveStatus(this.staging, repository);
    await this.staging.stageAll(repository);
  }
}

export class UnstageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.unstageAll", { repository: true });
  }

  public async execute(repository: Repository) {
    await ensureWorkingCopyLiveStatus(this.staging, repository);
    await this.staging.unstageAll(repository);
  }
}
