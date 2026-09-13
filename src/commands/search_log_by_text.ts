import { Command } from "./command";
import { window, Uri, commands, ProgressLocation, workspace } from "vscode";
import { Repository } from "../repository";
import { tempSvnFs } from "../temp_svn_fs";
import SvnError, { getErrorMessage } from "../svnError";
import { SvnCancellationError } from "../svnProcess";

export class SearchLogByText extends Command {
  private activeSearch?: AbortController;
  private disposed = false;

  constructor() {
    super("svn.searchLogByText", { repository: true });
  }

  public async execute(repository: Repository) {
    const input = await window.showInputBox({ prompt: "Search query" });
    if (!input || this.disposed) {
      return;
    }

    // The shared result document has exactly one active writer.
    this.activeSearch?.abort();
    const controller = new AbortController();
    this.activeSearch = controller;
    const uri = Uri.parse("tempsvnfs:/svn.log");
    const closed = workspace.onDidCloseTextDocument(document => {
      if (document.uri.toString() === uri.toString()) {
        controller.abort();
      }
    });
    try {
      tempSvnFs.writeFile(uri, Buffer.from(""), {
        create: true,
        overwrite: true
      });
      await commands.executeCommand<void>("vscode.open", uri);
      await window.withProgress(
        {
          cancellable: true,
          location: ProgressLocation.Notification,
          title: "Searching Log"
        },
        async (_progress, token) => {
          const cancellation = token.onCancellationRequested(() =>
            controller.abort()
          );
          if (token.isCancellationRequested) {
            controller.abort();
          }
          try {
            await repository.searchLogByText(
              input,
              controller.signal,
              content => {
                if (!controller.signal.aborted) {
                  tempSvnFs.writeFile(uri, Buffer.from(content), {
                    create: true,
                    overwrite: true
                  });
                }
              }
            );
          } finally {
            cancellation.dispose();
          }
        }
      );
    } catch (error) {
      if (!(error instanceof SvnCancellationError)) {
        await window.showErrorMessage(
          `Unable to search SVN log: ${error instanceof SvnError ? error.displayMessage : getErrorMessage(error)}`
        );
      }
    } finally {
      closed.dispose();
      if (this.activeSearch === controller) {
        this.activeSearch = undefined;
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.activeSearch?.abort();
    super.dispose();
  }
}
