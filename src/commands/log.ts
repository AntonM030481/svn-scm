import { posix as path } from "path";
import { commands, Uri, window } from "vscode";
import { SvnUriAction } from "../common/types";
import { Repository } from "../repository";
import { toSvnUri } from "../uri";
import { Command } from "./command";
import { selectWorkingCopyScope } from "./workingCopyScopes";

export class Log extends Command {
  constructor() {
    super("svn.log", { repository: true });
  }

  public async execute(repository: Repository, hint?: unknown) {
    try {
      if (hint === repository.sourceControl) {
        const scope = await selectWorkingCopyScope(
          repository,
          "Choose an opened folder to show history"
        );
        if (!scope) return;
        repository = scope;
      }
      const resource = toSvnUri(
        Uri.file(repository.workspaceRoot),
        SvnUriAction.LOG
      );
      const uri = resource.with({
        path: path.join(resource.path, "svn.log") // change document title
      });

      await commands.executeCommand<void>("vscode.open", uri);
    } catch (error) {
      console.error(error);
      window.showErrorMessage("Unable to log");
    }
  }
}
