import * as assert from "assert";
import { getEventListeners } from "events";
import { runSvnProcess, SvnCancellationError, waitForSvn } from "../svnProcess";

const nodeOptions = {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
};

suite("SVN process lifecycle", () => {
  test("cancellable waits settle without waiting for an uncooperative producer", async () => {
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void;
    const source = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
    const waiting = waitForSvn(source, controller.signal);
    controller.abort();
    await assert.rejects(waiting, SvnCancellationError);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    rejectLate(new Error("late failure"));
    await new Promise(resolve => setImmediate(resolve));
  });

  test("honors executable, cwd, environment and literal arguments without a shell", async () => {
    const input = 'space "quote" ; $(echo injected) --option';
    const result = await runSvnProcess(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.SVN_TEST}))",
        "--",
        input
      ],
      {
        ...nodeOptions,
        cwd: process.cwd(),
        env: { ...nodeOptions.env, SVN_TEST: "custom" }
      }
    );
    assert.deepStrictEqual(JSON.parse(result.stdout.toString()), {
      args: [input],
      cwd: process.cwd(),
      env: "custom"
    });
  });

  test("delivers stdout before process completion and waits for all output", async () => {
    const chunks: string[] = [];
    const result = await runSvnProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("first");setTimeout(()=>process.stdout.write("last"),50)'
      ],
      nodeOptions,
      undefined,
      chunk => chunks.push(chunk.toString())
    );
    assert.equal(chunks.join(""), "firstlast");
    assert.equal(result.stdout.toString(), "firstlast");
  });

  test("preserves stderr and non-zero exit status", async () => {
    const result = await runSvnProcess(
      process.execPath,
      ["-e", 'process.stderr.write("denied");process.exitCode=7'],
      nodeOptions
    );
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "denied");
  });

  test("reports spawn failures and removes cancellation listeners", async () => {
    const controller = new AbortController();
    await assert.rejects(
      runSvnProcess(
        "/nonexistent-svn-executable",
        [],
        nodeOptions,
        controller.signal
      ),
      /ENOENT/
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("pre-cancellation does not try to spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runSvnProcess(
        "/nonexistent-svn-executable",
        [],
        nodeOptions,
        controller.signal
      ),
      SvnCancellationError
    );
  });

  test("cancellation stops an active process and releases listeners", async () => {
    const controller = new AbortController();
    let chunks = 0;
    await assert.rejects(
      runSvnProcess(
        process.execPath,
        [
          "-e",
          'process.stdout.write("ready");setInterval(()=>process.stdout.write("late"),20)'
        ],
        nodeOptions,
        controller.signal,
        () => {
          chunks++;
          controller.abort();
        }
      ),
      SvnCancellationError
    );
    assert.equal(chunks, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("a failing output consumer terminates the process and rejects", async () => {
    const failure = new Error("consumer failure");
    await assert.rejects(
      runSvnProcess(
        process.execPath,
        ["-e", 'process.stdout.write("ready");setInterval(()=>{},100)'],
        nodeOptions,
        undefined,
        () => {
          throw failure;
        }
      ),
      error => error === failure
    );
  });
});
