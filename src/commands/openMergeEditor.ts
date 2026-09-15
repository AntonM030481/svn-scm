import { commands, SourceControlResourceState } from "vscode";
import { openMergeEditor } from "../mergeEditor";
import { Command } from "./command";

export class OpenMergeEditor extends Command {
  constructor() {
    super("svn.openMergeEditor");
  }

  public async execute(resourceState: SourceControlResourceState) {
    const selection = await this.getResourceStates([resourceState], true);
    const resource = selection[0];
    if (!resource) return;

    let opened = false;
    try {
      await this.runByRepository([resource.resourceUri], async repository => {
        if (!repository) return;
        const inputs = await repository.getTextConflictInputs(
          resource.resourceUri.fsPath
        );
        if (inputs) {
          opened = await openMergeEditor(inputs, resource.resourceUri);
        }
      });
    } catch (error) {
      console.warn("Unable to load SVN conflict inputs", error);
    }

    if (!opened) {
      await commands.executeCommand("vscode.open", resource.resourceUri);
    }
  }
}
