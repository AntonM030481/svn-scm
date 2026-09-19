import { Uri, window } from "vscode";
import { Command } from "./command";
import { LineChange } from "../common/types";
import { pathEquals } from "../util";

export class RevertChange extends Command {
  constructor() {
    super("svn.revertChange");
  }

  public async execute(uri: Uri, changes: LineChange[], index: number) {
    const textEditor = window.visibleTextEditors.find(
      editor =>
        editor.document.uri.scheme === "file" &&
        uri.scheme === "file" &&
        pathEquals(editor.document.uri.fsPath, uri.fsPath)
    );

    if (!textEditor) {
      return;
    }

    await this._revertChanges(textEditor, [
      ...changes.slice(0, index),
      ...changes.slice(index + 1)
    ]);
  }
}
