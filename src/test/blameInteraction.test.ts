import * as assert from "assert";
import {
  commands,
  Disposable,
  EventEmitter,
  TextEditor,
  Uri,
  window,
  workspace
} from "vscode";
import { BlameController } from "../blameController";
import { BlameSession } from "../blameSession";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { ISvnLogEntry } from "../common/types";
import { activeExtension } from "./testUtil";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function editor(file: string, line = 0): TextEditor {
  return {
    document: {
      uri: Uri.file(file),
      version: 1,
      isDirty: false,
      isClosed: false
    },
    selection: { active: { line } }
  } as TextEditor;
}

suite("Blame interaction", () => {
  suiteSetup(activeExtension);

  test("shares a pending revision lookup and decorates the latest selection", async () => {
    const log = deferred<ISvnLogEntry | undefined>();
    let calls = 0;
    let signal!: AbortSignal;
    const session = new BlameSession(
      {
        blameLog: (_file: string, _revision: string, abort: AbortSignal) => {
          calls++;
          signal = abort;
          return log.promise;
        }
      } as unknown as Repository,
      [
        { line: 1, revision: "7" },
        { line: 2, revision: "7" }
      ]
    );
    const rendered: Array<[number, string | undefined]> = [];
    (session as any).decorations = {
      clearActive() {},
      renderGutter() {},
      dispose() {},
      renderActive: (target: TextEditor, _blame: unknown, message?: string) => {
        rendered.push([target.selection.active.line, message]);
      }
    };
    const target = editor("/blame/shared.txt");
    try {
      const first = session.select(target);
      (target.selection.active as any).line = 1;
      const second = session.select(target);
      assert.equal(calls, 1);
      assert.equal(signal.aborted, false);
      log.resolve({ msg: "shared log" } as ISvnLogEntry);
      await Promise.all([first, second]);
      assert.deepStrictEqual(
        rendered.filter(([, message]) => message),
        [[1, "shared log"]]
      );
      await session.select(target);
      assert.equal(calls, 1);
    } finally {
      session.dispose();
    }
  });

  test("cancels obsolete log requests on revision change and disposal", async () => {
    const requests: Array<{
      signal: AbortSignal;
      result: ReturnType<typeof deferred<ISvnLogEntry | undefined>>;
    }> = [];
    const session = new BlameSession(
      {
        blameLog: (_file: string, _revision: string, signal: AbortSignal) => {
          const result = deferred<ISvnLogEntry | undefined>();
          requests.push({ signal, result });
          return result.promise;
        }
      } as unknown as Repository,
      [
        { line: 1, revision: "7" },
        { line: 2, revision: "8" }
      ]
    );
    (session as any).decorations = {
      clearActive() {},
      renderActive() {},
      renderGutter() {},
      dispose() {}
    };
    const target = editor("/blame/cancel.txt");
    try {
      const first = session.select(target);
      (target.selection.active as any).line = 1;
      const second = session.select(target);
      assert.equal(requests[0].signal.aborted, true);
      assert.equal(requests[1].signal.aborted, false);
      session.dispose();
      assert.equal(requests[1].signal.aborted, true);
      requests.forEach(request => request.result.resolve(undefined));
      await Promise.all([first, second]);
    } finally {
      session.dispose();
    }
  });

  suite("Controller lifecycle", () => {
    const restores: Array<() => void> = [];
    const opened = new EventEmitter<Repository>();
    const closed = new EventEmitter<Repository>();
    const listeners = new Map<string, (event: any) => void>();
    let controller: BlameController;
    let active: TextEditor | undefined;
    let lookup: (uri: Uri) => Promise<Repository | undefined>;

    function stub(object: any, key: string, value: unknown) {
      const original = object[key];
      object[key] = value;
      restores.push(() => {
        object[key] = original;
      });
    }

    setup(() => {
      active = undefined;
      lookup = async () => undefined;
      stub(commands, "registerCommand", () => new Disposable(() => {}));
      const descriptor = Object.getOwnPropertyDescriptor(
        window,
        "activeTextEditor"
      )!;
      Object.defineProperty(window, "activeTextEditor", {
        configurable: true,
        get: () => active
      });
      restores.push(() =>
        Object.defineProperty(window, "activeTextEditor", descriptor)
      );
      stub(workspace, "getConfiguration", () => ({
        get: (key: string) => key === "blame.auto"
      }));
      for (const [object, keys] of [
        [
          window,
          [
            "onDidChangeActiveTextEditor",
            "onDidChangeTextEditorSelection",
            "onDidChangeTextEditorVisibleRanges"
          ]
        ],
        [
          workspace,
          [
            "onDidChangeTextDocument",
            "onDidSaveTextDocument",
            "onDidChangeConfiguration",
            "onDidCloseTextDocument"
          ]
        ]
      ] as const) {
        for (const key of keys)
          stub(object, key, (listener: (event: any) => void) => {
            listeners.set(key, listener);
            return new Disposable(() => listeners.delete(key));
          });
      }
      controller = new BlameController({
        onDidOpenRepository: opened.event,
        onDidCloseRepository: closed.event,
        getRepositoryFromUri: (uri: Uri) => lookup(uri)
      } as SourceControlManager);
    });

    teardown(() => {
      controller?.dispose();
      restores
        .splice(0)
        .reverse()
        .forEach(restore => restore());
      listeners.clear();
    });

    suiteTeardown(() => {
      opened.dispose();
      closed.dispose();
    });

    test("revalidates an unversioned active file after initial status on reopen", async () => {
      const status = deferred<void>();
      let pending = true;
      let calls = 0;
      let lookups = 0;
      const repository = {
        get isInitialStatusPending() {
          return pending;
        },
        initialStatusSettled: status.promise,
        blame: async () => {
          calls++;
          return [];
        }
      } as unknown as Repository;
      lookup = async () => {
        lookups++;
        return pending ? repository : undefined;
      };
      active = editor("/blame/unversioned.txt");
      opened.fire(repository);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(lookups, 1);
      assert.equal(calls, 0);
      pending = false;
      status.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(lookups, 2);
      assert.equal(calls, 0);
      assert.equal((controller as any).pendingBlame.size, 0);
    });

    test("restarts auto-blame for the active file after repository reopen", async () => {
      let calls = 0;
      const repository = {
        blame: async () => {
          calls++;
          return [];
        }
      } as unknown as Repository;
      lookup = async () => repository;
      active = editor("/blame/versioned.txt");
      opened.fire(repository);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      closed.fire(repository);
      opened.fire(repository);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 2);
    });

    test("debounces each editor and cancels pending work on close and disposal", async () => {
      const targets = [editor("/blame/one.txt"), editor("/blame/two.txt")];
      const counts = targets.map(() => ({ render: 0, select: 0 }));
      targets.forEach((target, i) =>
        (controller as any).sessions.set(target.document.uri.fsPath, {
          render: () => counts[i].render++,
          select: () => counts[i].select++,
          dispose() {}
        })
      );
      const fire = () => {
        for (let i = 0; i < 3; i++)
          for (const target of targets) {
            listeners.get("onDidChangeTextEditorVisibleRanges")!({
              textEditor: target
            });
            listeners.get("onDidChangeTextEditorSelection")!({
              textEditor: target
            });
          }
      };
      fire();
      await new Promise(resolve => setTimeout(resolve, 110));
      assert.deepStrictEqual(counts, [
        { render: 1, select: 1 },
        { render: 1, select: 1 }
      ]);
      fire();
      listeners.get("onDidCloseTextDocument")!(targets[0].document);
      controller.dispose();
      await new Promise(resolve => setTimeout(resolve, 110));
      assert.deepStrictEqual(counts, [
        { render: 1, select: 1 },
        { render: 1, select: 1 }
      ]);
    });
  });
});
