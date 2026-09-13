import * as cp from "child_process";

export class SvnCancellationError extends Error {
  constructor() {
    super("SVN command cancelled");
    this.name = "AbortError";
  }
}

/** Stop waiting immediately, while still observing late completion/rejection. */
export function waitForSvn<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(new SvnCancellationError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
    if (signal?.aborted) {
      cancel();
    }
  });
}

/** Owns a subprocess until close, including its pipes and cancellation listener. */
export function runSvnProcess(
  executable: string,
  args: string[],
  options: cp.SpawnOptions,
  signal?: AbortSignal,
  onStdout?: (chunk: Buffer) => void
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  if (signal?.aborted) {
    return Promise.reject(new SvnCancellationError());
  }

  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | undefined;

    const cancel = () => {
      failure = new SvnCancellationError();
      child.kill();
    };
    const onError = (error: Error) => {
      failure = failure || error;
    };
    const onStreamError = (error: Error) => {
      onError(error);
      child.kill();
    };
    const onData = (chunk: Buffer) => {
      stdout.push(chunk);
      if (failure) {
        return;
      }
      try {
        onStdout?.(chunk);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
    };
    const onStderr = (chunk: Buffer) => stderr.push(chunk);

    child.on("error", onError);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);
    child.once("close", (exitCode, exitSignal) => {
      signal?.removeEventListener("abort", cancel);
      child.removeListener("error", onError);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("error", onStreamError);
      child.stderr?.removeListener("error", onStreamError);

      if (failure) {
        reject(failure);
      } else if (exitCode === null) {
        reject(
          new Error(
            `SVN command terminated by ${exitSignal || "unknown signal"}`
          )
        );
      } else {
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
    }
  });
}
