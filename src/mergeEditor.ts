import { commands, Uri } from "vscode";
import { ISvnTextConflictInputs } from "./common/types";

const openMergeEditorCommand = "_open.mergeEditor";

interface CommandApi {
  getCommands(filterInternal?: boolean): Thenable<string[]>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

export async function openMergeEditor(
  inputs: ISvnTextConflictInputs,
  output: Uri,
  commandApi: CommandApi = commands
): Promise<boolean> {
  const available = await commandApi.getCommands(true);
  if (!available.includes(openMergeEditorCommand)) {
    return false;
  }

  try {
    await commandApi.executeCommand(openMergeEditorCommand, {
      base: Uri.file(inputs.base),
      input1: { uri: Uri.file(inputs.incoming), title: "Incoming" },
      input2: { uri: Uri.file(inputs.current), title: "Current" },
      output
    });
    return true;
  } catch (error) {
    console.warn("Unable to open VS Code merge editor", error);
    return false;
  }
}
