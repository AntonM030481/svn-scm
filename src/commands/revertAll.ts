import { window } from "vscode";
import { ISvnResourceGroup } from "../common/types";
import { checkAndPromptDepth, confirmRevert } from "../input/revert";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

export class RevertAll extends Command {
  constructor() {
    super("svn.revertAll");
  }

  public async execute(resourceGroup: ISvnResourceGroup) {
    const owner = resourceGroup.repository;
    if (owner) {
      await Promise.all(
        (await workingCopyScopes(owner)).map(scope => scope.ensureStatus())
      );
    }
    const resourceStates = resourceGroup.resourceStates;

    if (resourceStates.length === 0 || !(await confirmRevert())) {
      return;
    }

    const uris = resourceStates.map(resource => resource.resourceUri);
    const depth = await checkAndPromptDepth(uris);

    if (!depth) {
      return;
    }

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const paths = resources.map(resource => resource.fsPath).reverse();

      try {
        await repository.revert(paths, depth);
      } catch (error) {
        console.log(error);
        window.showErrorMessage("Unable to revert");
      }
    });
  }
}
