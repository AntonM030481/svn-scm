import { SourceControlResourceState } from "vscode";
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

export class Stage extends BaseStagingCommand {
  constructor(staging: StagingCoordinator) {
    super("svn.stage", staging);
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const resources = await this.selectedResources(resourceStates);
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
    const resources = await this.selectedResources(resourceStates);
    if (resources.length) {
      await this.staging.unstage(resources);
    }
  }
}

export class StageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.stageAll", { repository: true });
  }

  public async execute(repository: import("../repository").Repository) {
    await this.staging.stageAll(repository);
  }
}

export class UnstageAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.unstageAll", { repository: true });
  }

  public async execute(repository: import("../repository").Repository) {
    await this.staging.unstageAll(repository);
  }
}
