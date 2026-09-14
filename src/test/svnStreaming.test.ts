import * as assert from "assert";
import { Svn, svnErrorCodes } from "../svn";
import SvnError from "../svnError";
import { Repository as SvnRepository } from "../svnRepository";
import { ConstructorPolicy, ICpOptions } from "../common/types";
import { Repository } from "../repository";
import { CancellationToken, commands, EventEmitter } from "vscode";
import { SvnCancellationError } from "../svnProcess";
import { getEventListeners } from "events";

const environment = { ELECTRON_RUN_AS_NODE: "1" };

suite("Configured SVN streaming executor", () => {
  test("cancellation releases a pending secret lookup immediately", async () => {
    const repository = Object.create(Repository.prototype) as any;
    const controller = new AbortController();
    let complete!: (value: string) => void;
    repository.getCredentialServiceName = () => "test";
    repository.secrets = {
      get: () =>
        new Promise<string>(resolve => {
          complete = resolve;
        })
    };
    const waiting = repository.loadStoredAuths(controller.signal);
    controller.abort();
    await assert.rejects(waiting, SvnCancellationError);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    complete("[]");
    await Promise.resolve();
  });

  test("cancelled auth UI cannot apply late credentials or block another caller", async () => {
    const repository = Object.create(Repository.prototype) as any;
    repository.repository = {};
    const first = new AbortController();
    const second = new AbortController();
    const original = commands.executeCommand;
    const completions: Array<
      (auth: { username: string; password: string }) => void
    > = [];
    let cancelledUI = false;
    commands.executeCommand = ((
      _command: string,
      _username: unknown,
      _password: unknown,
      token: CancellationToken
    ) => {
      token.onCancellationRequested(() => {
        cancelledUI = true;
      });
      return new Promise<{ username: string; password: string }>(resolve => {
        completions.push(resolve);
      });
    }) as unknown as typeof commands.executeCommand;
    try {
      const cancelled = repository.promptAuth(first.signal);
      const replacement = repository.promptAuth(second.signal);
      first.abort();
      await assert.rejects(cancelled, SvnCancellationError);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cancelledUI, true);
      assert.equal(completions.length, 2);
      completions[0]({ username: "stale", password: "old" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(repository.repository.username, undefined);
      completions[1]({ username: "current", password: "new" });
      await replacement;
      assert.equal(repository.repository.username, "current");
      assert.equal(repository.repository.password, "new");
      assert.equal(repository.lastPromptAuth, undefined);
      assert.equal(getEventListeners(first.signal, "abort").length, 0);
      assert.equal(getEventListeners(second.signal, "abort").length, 0);
    } finally {
      first.abort();
      second.abort();
      commands.executeCommand = original;
    }
  });

  test("flushes the decoder tail and leaves caller arguments/options unchanged", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    const args = ["-e", "process.stdout.write(Buffer.from([0xe2]))", "--"];
    const originalArgs = [...args];
    let streamed = "";
    const options: ICpOptions = {
      env: environment,
      encoding: "utf8",
      log: false,
      onStdout: chunk => {
        streamed += chunk;
      }
    };
    const result = await svn.exec(process.cwd(), args, options);
    assert.equal(streamed, "�");
    assert.equal(result.stdout, streamed);
    assert.deepStrictEqual(args, originalArgs);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.cwd, undefined);
  });

  test("cancellation during auth lookup cannot start another attempt or prompt", async () => {
    const repository = Object.create(Repository.prototype) as any;
    const controller = new AbortController();
    let attempts = 0;
    let prompts = 0;
    repository.repository = {};
    repository.loadStoredAuths = async () => {
      controller.abort();
      return [{ account: "user", password: "password" }];
    };
    repository.promptAuth = async () => {
      prompts++;
    };
    await assert.rejects(
      repository.retryRun(async () => {
        attempts++;
        throw new SvnError({ svnErrorCode: svnErrorCodes.AuthorizationFailed });
      }, controller.signal),
      SvnCancellationError
    );
    assert.equal(attempts, 1);
    assert.equal(prompts, 0);
    assert.equal(repository.repository.username, undefined);
  });

  test("auth retries replace partial snapshots and release lifecycle listeners", async () => {
    const repository = Object.create(Repository.prototype) as any;
    const emitter = new EventEmitter<void>();
    const controller = new AbortController();
    const snapshots: string[] = [];
    let attempts = 0;
    repository.onDidDispose = emitter.event;
    repository.disposed = false;
    repository.saveAuth = () => {};
    repository.loadStoredAuths = async () => [];
    repository.run = (
      _operation: unknown,
      fn: () => Promise<void>,
      _force: boolean,
      signal: AbortSignal
    ) => repository.retryRun(fn, signal);
    repository.repository = {
      plainLogByText: async (_query: string, options: ICpOptions) => {
        attempts++;
        options.onStdout?.(attempts === 1 ? "partial" : "complete");
        if (attempts === 1) {
          throw new SvnError({
            svnErrorCode: svnErrorCodes.AuthorizationFailed
          });
        }
      }
    };
    try {
      await repository.searchLogByText(
        "query",
        controller.signal,
        (content: string) => snapshots.push(content)
      );
      assert.deepStrictEqual(snapshots, ["", "partial", "", "complete"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      emitter.dispose();
    }
  });

  test("repository disposal cancels the active search", async () => {
    const repository = Object.create(Repository.prototype) as any;
    const emitter = new EventEmitter<void>();
    const controller = new AbortController();
    repository.onDidDispose = emitter.event;
    repository.disposed = false;
    repository.run = (_operation: unknown, fn: () => Promise<void>) => fn();
    repository.repository = {
      plainLogByText: async (_query: string, options: ICpOptions) => {
        emitter.fire();
        assert.equal(options.signal?.aborted, true);
        throw new SvnCancellationError();
      }
    };
    try {
      await assert.rejects(
        repository.searchLogByText("query", controller.signal, () => {}),
        SvnCancellationError
      );
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      emitter.dispose();
    }
  });

  test("shares path, environment, auth arguments and logging with buffered exec", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    const logs: string[] = [];
    svn.onOutput.on("log", value => logs.push(value));
    let streamed = "";
    const result = await svn.exec(
      process.cwd(),
      [
        "-e",
        "console.log(JSON.stringify({args:process.argv.slice(1),locale:process.env.LC_ALL,custom:process.env.SVN_TEST}))",
        "--"
      ],
      {
        username: "test-user",
        password: "test-secret",
        env: { ...environment, SVN_TEST: "custom" },
        logReason: "log-search",
        onStdout: chunk => {
          streamed += chunk;
        }
      }
    );
    assert.equal(result.stdout, streamed);
    const output = JSON.parse(streamed);
    assert.deepStrictEqual(output.args, [
      "--username",
      "test-user",
      "--password",
      "test-secret",
      "--config-option",
      "config:auth:password-stores=",
      "--config-option",
      "servers:global:store-auth-creds=no",
      "--non-interactive"
    ]);
    assert.equal(output.locale, "en_US.UTF-8");
    assert.equal(output.custom, "custom");
    assert.ok(logs.join("").includes("[log-search]"));
    assert.ok(!logs.join("").includes("test-secret"));
  });

  test("decodes a character split between stdout chunks", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    const chunks: string[] = [];
    const result = await svn.exec(
      process.cwd(),
      [
        "-e",
        "process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),50)",
        "--"
      ],
      {
        env: environment,
        encoding: "utf8",
        log: false,
        onStdout: chunk => chunks.push(chunk)
      }
    );
    assert.equal(chunks.join(""), "€");
    assert.equal(result.stdout, "€");
  });

  test("respects explicit non-UTF8 streaming encoding", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    let streamed = "";
    const result = await svn.exec(
      process.cwd(),
      [
        "-e",
        "process.stdout.write(Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]))",
        "--"
      ],
      {
        env: environment,
        encoding: "windows-1251",
        log: false,
        onStdout: chunk => {
          streamed += chunk;
        }
      }
    );
    assert.equal(streamed, "Привет");
    assert.equal(result.stdout, streamed);
  });

  test("classifies SVN exit failures for repository authentication retry", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    await assert.rejects(
      svn.exec(
        process.cwd(),
        [
          "-e",
          'process.stderr.write("svn: E170001: Authorization failed");process.exitCode=1',
          "--"
        ],
        { env: environment, log: false, onStdout: () => {} }
      ),
      error =>
        error instanceof SvnError &&
        error.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
        error.displayMessage === "Authorization failed"
    );
  });

  test("preserves unknown SVN error codes and prefers errors over warnings", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    await assert.rejects(
      svn.exec(
        process.cwd(),
        [
          "-e",
          'process.stderr.write("svn: W123456: /tmp/E654321 was skipped\\nsvn: E200009: operation failed");process.exitCode=1',
          "--"
        ],
        { env: environment, log: false, onStdout: () => {} }
      ),
      error => error instanceof SvnError && error.svnErrorCode === "E200009"
    );
  });

  test("classifies localized no-more-credentials failures by code", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    await assert.rejects(
      svn.exec(
        process.cwd(),
        [
          "-e",
          'process.stderr.write("svn: E215004: Localized message");process.exitCode=1',
          "--"
        ],
        { env: environment, log: false, onStdout: () => {} }
      ),
      error =>
        error instanceof SvnError &&
        error.svnErrorCode === svnErrorCodes.AuthorizationFailed
    );
  });

  test("does not classify error codes mentioned inside diagnostic text", async () => {
    const svn = new Svn({ svnPath: process.execPath, version: "1.14.0" });
    await assert.rejects(
      svn.exec(
        process.cwd(),
        [
          "-e",
          'process.stderr.write("svn: E155007: /workspace/E215004 is not a working copy");process.exitCode=1',
          "--"
        ],
        { env: environment, log: false, onStdout: () => {} }
      ),
      error =>
        error instanceof SvnError &&
        error.svnErrorCode === svnErrorCodes.NotASvnRepository
    );
  });

  test("log search keeps query as one argument and applies repository credentials", async () => {
    let capturedArgs: string[] = [];
    let capturedOptions: ICpOptions = {};
    const svn = {
      exec: async (_cwd: string, args: string[], options: ICpOptions) => {
        capturedArgs = args;
        capturedOptions = options;
        options.onStdout?.("result");
        return { stdout: "result", stderr: "", exitCode: 0 };
      }
    } as unknown as Svn;
    const repository = await new SvnRepository(
      svn,
      "/root",
      "/workspace",
      ConstructorPolicy.LateInit
    );
    repository.username = "user";
    repository.password = "password";
    const query = 'query "quoted" ; --all $(injection)';
    const controller = new AbortController();
    let streamed = "";
    await repository.plainLogByText(query, {
      signal: controller.signal,
      onStdout: chunk => {
        streamed += chunk;
      }
    });
    assert.deepStrictEqual(capturedArgs, ["log", "--search", query]);
    assert.equal(capturedOptions.logReason, "log-search");
    assert.equal(capturedOptions.username, "user");
    assert.equal(capturedOptions.password, "password");
    assert.equal(capturedOptions.signal, controller.signal);
    assert.equal(streamed, "result");
  });
});
