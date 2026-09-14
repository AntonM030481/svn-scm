import { commands, SourceControlResourceState, Uri } from "vscode";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { SourceControlManager } from "../source_control_manager";
import { StagingCoordinator } from "../stagingCoordinator";
import { Command } from "./command";

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

    // SCM menu actions are contributed by package.json and VS Code is free to
    // forward resource-state-shaped objects rather than our concrete Resource
    // instances. Resolve those arguments structurally by URI instead of
    // silently dropping them via `instanceof Resource`.
    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;
    const resources: Resource[] = [];

    for (const resourceState of resourceStates) {
      const uri = resourceState?.resourceUri;
      if (!(uri instanceof Uri)) continue;

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
