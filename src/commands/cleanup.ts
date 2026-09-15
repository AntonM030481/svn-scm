import { Repository } from "../repository";
import { Command } from "./command";
import { runWorkingCopyOperation } from "./workingCopyScopes";

export class Cleanup extends Command {
  constructor() {
    super("svn.cleanup", { repository: true });
  }

  public async execute(repository: Repository) {
    await runWorkingCopyOperation(repository, scope => scope.cleanup());
  }
}
