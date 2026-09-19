import * as assert from "assert";
import { Position, Uri, window, workspace } from "vscode";
import { Command } from "../commands/command";

class TestCommand extends Command {
  constructor() {
    super("svn.test.revertChangeOrdering");
  }

  public execute(): void {}

  public revert(textEditor: any): Promise<void> {
    return this._revertChanges(textEditor, []);
  }
}

suite("Command async edit behavior", () => {
  test("revert change waits for WorkspaceEdit before saving", async () => {
    const command = new TestCommand();
    const originalOpenTextDocument = workspace.openTextDocument;
    const originalApplyEdit = workspace.applyEdit;
    let releaseEdit!: () => void;
    const editGate = new Promise<void>(resolve => {
      releaseEdit = resolve;
    });
    let editApplied = false;
    let saveCalls = 0;

    const modifiedDocument = {
      uri: Uri.file("/tmp/svn-revert-change.txt"),
      lineCount: 1,
      lineAt: () => ({ range: { end: new Position(0, 4) } }),
      save: async () => {
        assert.equal(editApplied, true);
        saveCalls += 1;
        return true;
      }
    };
    const originalDocument = {
      lineCount: 1,
      getText: () => "base\n"
    };

    (workspace as any).openTextDocument = async () => originalDocument;
    (workspace as any).applyEdit = async () => {
      await editGate;
      editApplied = true;
      return true;
    };

    try {
      const pending = command.revert({ document: modifiedDocument });
      await Promise.resolve();
      assert.equal(saveCalls, 0);

      releaseEdit();
      await pending;

      assert.equal(saveCalls, 1);
    } finally {
      releaseEdit();
      (workspace as any).openTextDocument = originalOpenTextDocument;
      (workspace as any).applyEdit = originalApplyEdit;
      command.dispose();
    }
  });

  test("revert change does not save when WorkspaceEdit is rejected", async () => {
    const command = new TestCommand();
    const originalOpenTextDocument = workspace.openTextDocument;
    const originalApplyEdit = workspace.applyEdit;
    const originalShowErrorMessage = window.showErrorMessage;
    let saveCalls = 0;
    let errors = 0;

    const modifiedDocument = {
      uri: Uri.file("/tmp/svn-revert-change-rejected.txt"),
      lineCount: 1,
      lineAt: () => ({ range: { end: new Position(0, 4) } }),
      save: async () => {
        saveCalls += 1;
        return true;
      }
    };
    const originalDocument = {
      lineCount: 1,
      getText: () => "base\n"
    };

    (workspace as any).openTextDocument = async () => originalDocument;
    (workspace as any).applyEdit = async () => false;
    (window as any).showErrorMessage = async () => {
      errors += 1;
      return undefined;
    };

    try {
      await command.revert({ document: modifiedDocument });
      assert.equal(saveCalls, 0);
      assert.equal(errors, 1);
    } finally {
      (workspace as any).openTextDocument = originalOpenTextDocument;
      (workspace as any).applyEdit = originalApplyEdit;
      window.showErrorMessage = originalShowErrorMessage;
      command.dispose();
    }
  });
});
