import * as assert from "assert";
import { CancellationTokenSource, commands, Uri, window } from "vscode";
import { SearchLogByText } from "../commands/search_log_by_text";
import { Repository } from "../repository";
import { SvnCancellationError } from "../svnProcess";
import { tempSvnFs } from "../temp_svn_fs";

suite("Log search command lifecycle", () => {
  const uri = Uri.parse("tempsvnfs:/svn.log");
  let originalInput: typeof window.showInputBox;
  let originalProgress: typeof window.withProgress;
  let originalOpen: typeof commands.executeCommand;
  let originalError: typeof window.showErrorMessage;
  let cancellation: CancellationTokenSource;
  let command: SearchLogByText;
  let errors: string[];

  setup(() => {
    originalInput = window.showInputBox;
    originalProgress = window.withProgress;
    originalOpen = commands.executeCommand;
    originalError = window.showErrorMessage;
    cancellation = new CancellationTokenSource();
    command = Object.create(SearchLogByText.prototype);
    errors = [];
    window.showInputBox = async () => "query";
    window.withProgress = (_options, task) =>
      task({ report: () => {} }, cancellation.token);
    commands.executeCommand = async () => undefined as any;
    window.showErrorMessage = (async (message: string) => {
      errors.push(message);
    }) as typeof window.showErrorMessage;
  });

  teardown(() => {
    command.dispose();
    cancellation.dispose();
    window.showInputBox = originalInput;
    window.withProgress = originalProgress;
    commands.executeCommand = originalOpen;
    window.showErrorMessage = originalError;
    try {
      tempSvnFs.delete(uri);
    } catch {
      /* No document was created. */
    }
  });

  test("awaits progress while publishing streamed content", async () => {
    let complete!: () => void;
    const repository = {
      searchLogByText: async (
        _query: string,
        _signal: AbortSignal,
        onContent: (content: string) => void
      ) => {
        onContent("streaming");
        await new Promise<void>(resolve => {
          complete = resolve;
        });
      }
    } as unknown as Repository;
    let settled = false;
    const execution = command.execute(repository).then(() => {
      settled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Buffer.from(tempSvnFs.readFile(uri)).toString(), "streaming");
    assert.equal(settled, false);
    complete();
    await execution;
    assert.equal(settled, true);
  });

  test("a replacement search suppresses late output from its cancelled predecessor", async () => {
    const first = {
      searchLogByText: async (
        _query: string,
        signal: AbortSignal,
        onContent: (content: string) => void
      ) => {
        onContent("first");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              setImmediate(() => {
                onContent("stale");
                reject(new SvnCancellationError());
              });
            },
            { once: true }
          );
        });
      }
    } as unknown as Repository;
    const second = {
      searchLogByText: async (
        _query: string,
        _signal: AbortSignal,
        onContent: (content: string) => void
      ) => {
        onContent("second");
      }
    } as unknown as Repository;
    const previous = command.execute(first);
    await new Promise(resolve => setImmediate(resolve));
    await command.execute(second);
    await previous;
    assert.equal(Buffer.from(tempSvnFs.readFile(uri)).toString(), "second");
    assert.deepStrictEqual(errors, []);
  });

  test("user cancellation is quiet, but real failures are shown", async () => {
    await command.execute({
      searchLogByText: async (_query: string, signal: AbortSignal) => {
        cancellation.cancel();
        assert.equal(signal.aborted, true);
        throw new SvnCancellationError();
      }
    } as unknown as Repository);
    assert.deepStrictEqual(errors, []);
    cancellation.dispose();
    cancellation = new CancellationTokenSource();
    await command.execute({
      searchLogByText: async () => {
        throw new Error("configured client unavailable");
      }
    } as unknown as Repository);
    assert.deepStrictEqual(errors, [
      "Unable to search SVN log: configured client unavailable"
    ]);
  });

  test("disposing while the input box is pending cannot start a search", async () => {
    let accept!: (query: string) => void;
    window.showInputBox = () =>
      new Promise(resolve => {
        accept = resolve;
      });
    let searches = 0;
    const execution = command.execute({
      searchLogByText: async () => {
        searches++;
      }
    } as unknown as Repository);
    command.dispose();
    accept("query");
    await execution;
    assert.equal(searches, 0);
  });
});
