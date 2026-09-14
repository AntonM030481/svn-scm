import { SourceControlResourceState } from "vscode";
import { Repository } from "../repository";
import { Resource } from "../resource";
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
    return this.getResourceStates(resourceStates);
  }
}

async function ensureWorkingCopyLiveStatus(
  staging: StagingCoordinator,
  repository: Repository
): Promise<void> {
  await Promise.all(
    staging
      .repositoriesForWorkingCopy(repository)
      .map(peer => peer.ensureStatus())
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
