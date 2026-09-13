import * as path from "path";
import { SourceControlResourceState, window } from "vscode";
import { Status } from "../common/types";
import { inputCommitMessage } from "../messages";
import SvnError, { getErrorMessage } from "../svnError";
import { Command } from "./command";

export class Commit extends Command {
  constructor() {
    super("svn.commit");
  }

  public async execute(...resources: SourceControlResourceState[]) {
    const selection = await this.getResourceStates(resources, true);
    if (!selection.length) return;

    const uris = selection.map(resource => resource.resourceUri);
    selection.forEach(resource => {
      if (resource.type === Status.ADDED && resource.renameResourceUri) {
        uris.push(resource.renameResourceUri);
      }
    });

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const paths = resources.map(resource => resource.fsPath);

      for (const resource of resources) {
        let dir = path.dirname(resource.fsPath);
        let parent = repository.getResourceFromFile(dir);

        while (parent) {
          if (parent.type === Status.ADDED) {
            paths.push(dir);
          }
          dir = path.dirname(dir);
          parent = repository.getResourceFromFile(dir);
        }
      }

      try {
        const message = await inputCommitMessage(
          repository.inputBox.value,
          true,
          paths
        );

        if (message === undefined) {
          return;
        }

        repository.inputBox.value = message;

        const result = await repository.commitFiles(message, paths);
        window.showInformationMessage(result);
        repository.inputBox.value = "";
      } catch (error) {
        console.error(error);
        window.showErrorMessage(
          error instanceof SvnError
            ? error.displayMessage
            : getErrorMessage(error)
        );
      }
    });
  }
}
