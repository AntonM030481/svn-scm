import { Repository } from "../repository";
import { Operation } from "../common/types";
import { Command } from "./command";
import { runWorkingCopyOperation } from "./workingCopyScopes";

export class Cleanup extends Command {
  constructor() {
    super("svn.cleanup", { repository: true });
  }

  public async execute(repository: Repository) {
    await runWorkingCopyOperation(repository, Operation.CleanUp, scope =>
      scope.cleanup()
    );
  }
}
