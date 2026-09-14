import * as cp from "child_process";
import { EventEmitter } from "events";
import * as proc from "process";
import {
  ConstructorPolicy,
  ICpOptions,
  IExecutionResult,
  ISvnInfo,
  ISvnOptions
} from "./common/types";
import * as encodeUtil from "./encoding";
import { configuration } from "./helpers/configuration";
import { parseInfoXml } from "./parser/infoParser";
import SvnError from "./svnError";
import { Repository } from "./svnRepository";
import { runSvnProcess } from "./svnProcess";
import * as iconv from "@vscode/iconv-lite-umd";

const SLOW_COMMAND_LOG_MS = 250;

function pad(value: number, width: number = 2): string {
  return value.toString().padStart(width, "0");
}

function formatOutputTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}.${pad(date.getMilliseconds(), 3)}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }

  return `${(milliseconds / 1000).toFixed(3)} s`;
}

export function getSvnLogReason(args: any[], explicitReason?: string): string {
  if (explicitReason) {
    return explicitReason;
  }

  const command = String(args[0] || "svn").toLowerCase();

  if (command === "info") {
    const hasTarget = args
      .slice(1)
      .some(arg => typeof arg === "string" && !arg.startsWith("-"));
    return hasTarget ? "path-info" : "repository-info";
  }

  if (command === "stat" || command === "status") {
    if (args.includes("--show-updates")) {
      return "remote-status";
    }

    const hasTarget = args
      .slice(1)
      .some(arg => typeof arg === "string" && !arg.startsWith("-"));
    return hasTarget ? "targeted-status" : "status";
  }

  if (command === "cat") {
    return "quick-diff";
  }

  return command;
}

function formatLogPrefix(date: Date, name: string | undefined, reason: string) {
  return `[${formatOutputTime(date)}] [${name}] [${reason}]$`;
}

export const svnErrorCodes: { [key: string]: string } = {
  AuthorizationFailed: "E170001",
  RepositoryIsLocked: "E155004",
  NotASvnRepository: "E155007",
  PropertyNotFound: "W200017",
  NotShareCommonAncestry: "E195012",
  WorkingCopyIsTooOld: "E155036"
};

function getSvnErrorCode(stderr: string): string | undefined {
  if (/^svn: E215004:/m.test(stderr)) {
    return svnErrorCodes.AuthorizationFailed;
  }

  for (const name in svnErrorCodes) {
    if (svnErrorCodes.hasOwnProperty(name)) {
      const code = svnErrorCodes[name];
      const regex = new RegExp(`^svn: (?:warning: )?${code}:`, "m");
      if (regex.test(stderr)) {
        return code;
      }
    }
  }

  if (/No more credentials or we tried too many times/.test(stderr)) {
    return svnErrorCodes.AuthorizationFailed;
  }

  return (
    stderr.match(/^svn: (E\d{6}):/m)?.[1] ??
    stderr.match(/^svn: (W\d{6}):/m)?.[1]
  );
}

function createSvnError(
  command: string,
  exitCode: number,
  stdout: string | Buffer,
  stderr: string
): SvnError {
  return new SvnError({
    message: "Failed to execute svn",
    stdout: Buffer.isBuffer(stdout) ? stdout.toString() : stdout,
    stderr,
    stderrFormated: stderr.replace(/^svn: E\d+: +/gm, ""),
    exitCode,
    svnErrorCode: getSvnErrorCode(stderr),
    svnCommand: command
  });
}

export function cpErrorHandler(
  cb: (reason?: any) => void
): (reason?: any) => void {
  return err => {
    if (/ENOENT/.test(err.message)) {
      err = new SvnError({
        error: err,
        message: "Failed to execute svn (ENOENT)",
        svnErrorCode: "NotASvnRepository"
      });
    }

    cb(err);
  };
}

export interface BufferResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

export class Svn {
  public version: string;

  private svnPath: string;
  private lastCwd: string = "";
  private initialRepositoryInfo = new Map<string, ISvnInfo>();

  private _onOutput = new EventEmitter();
  get onOutput(): EventEmitter {
    return this._onOutput;
  }

  constructor(options: ISvnOptions) {
    this.svnPath = options.svnPath;
    this.version = options.version;
  }

  public logOutput(output: string): void {
    this._onOutput.emit("log", output);
  }

  public async exec(
    cwd: string,
    args: any[],
    options: ICpOptions = {},
    explicitReason?: string
  ): Promise<IExecutionResult> {
    args = [...args];
    options = { ...options };
    if (cwd) {
      this.lastCwd = cwd;
      options.cwd = cwd;
    }

    const startedAt = new Date();
    const command = args[0];
    const name = (cwd || this.lastCwd).split(/[\\\/]+/).pop();
    const reason = getSvnLogReason(args, explicitReason || options.logReason);

    if (options.log !== false) {
      const argsOut = args.map(arg => (/ |^$/.test(arg) ? `'${arg}'` : arg));
      this.logOutput(
        `${formatLogPrefix(startedAt, name, reason)} svn ${argsOut.join(" ")}\n`
      );
    }

    if (options.username) {
      args.push("--username", options.username);
    }
    if (options.password) {
      args.push("--password", options.password);
    }

    if (options.username || options.password) {
      // Configuration format: FILE:SECTION:OPTION=[VALUE]
      // Disable password store
      args.push("--config-option", "config:auth:password-stores=");
      // Disable store auth credentials
      args.push("--config-option", "servers:global:store-auth-creds=no");
    }

    // Force non interactive environment
    args.push("--non-interactive");

    let encoding: string | undefined | null = options.encoding;
    delete options.encoding;

    // SVN with '--xml' always return 'UTF-8', and jschardet detects this encoding: 'TIS-620'
    if (args.includes("--xml")) {
      encoding = "utf8";
    }

    const defaults: cp.SpawnOptions = {
      env: proc.env
    };
    if (cwd) {
      defaults.cwd = cwd;
    }

    defaults.env = Object.assign({}, proc.env, options.env || {}, {
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8"
    });

    // A streaming decoder retains incomplete multibyte characters between chunks.
    // Detection requires complete output; streaming instead uses the configured encoding.
    if (options.onStdout && !encoding) {
      encoding = configuration.get<string>("default.encoding");
    }
    if (options.onStdout && (!encoding || !iconv.encodingExists(encoding))) {
      encoding = "utf8";
    }
    const decoder = options.onStdout ? iconv.getDecoder(encoding!) : undefined;
    const { exitCode, stdout, stderr } = await runSvnProcess(
      this.svnPath,
      args,
      defaults,
      options.signal,
      decoder
        ? chunk => {
            const text = decoder.write(chunk);
            if (text) {
              options.onStdout!(text);
            }
          }
        : undefined
    );
    const tail = decoder?.end();
    if (tail) {
      options.onStdout!(tail);
    }

    const duration = Date.now() - startedAt.getTime();
    if (options.log !== false && duration >= SLOW_COMMAND_LOG_MS) {
      const completedAt = new Date();
      this.logOutput(
        `${formatLogPrefix(
          completedAt,
          name,
          reason
        )} svn ${command} completed in ${formatDuration(duration)}\n`
      );
    }

    if (!encoding) {
      encoding = encodeUtil.detectEncoding(stdout);
    }

    // if not detected
    if (!encoding) {
      encoding = configuration.get<string>("default.encoding");
    }

    if (!iconv.encodingExists(encoding)) {
      if (encoding) {
        console.warn(`SVN: The encoding "${encoding}" is invalid`);
      }
      encoding = "utf8";
    }

    const decodedStdout = iconv.decode(stdout, encoding);

    if (options.log !== false && stderr.length > 0) {
      const errorTime = new Date();
      const err = stderr
        .split(/\r?\n/)
        .filter((line: string) => line.trim().length > 0)
        .map(
          (line: string) =>
            `${formatLogPrefix(errorTime, name, reason)} ${line}`
        )
        .join("\n");
      if (err) {
        this.logOutput(err + "\n");
      }
    }

    if (exitCode) {
      return Promise.reject<IExecutionResult>(
        createSvnError(args[0], exitCode, decodedStdout, stderr)
      );
    }

    return { exitCode, stdout: decodedStdout, stderr };
  }

  public async execBuffer(
    cwd: string,
    args: any[],
    options: ICpOptions = {},
    explicitReason?: string
  ): Promise<BufferResult> {
    args = [...args];
    options = { ...options };
    if (cwd) {
      this.lastCwd = cwd;
      options.cwd = cwd;
    }

    const startedAt = new Date();
    const command = args[0];
    const name = (cwd || this.lastCwd).split(/[\\\/]+/).pop();
    const reason = getSvnLogReason(args, explicitReason || options.logReason);

    if (options.log !== false) {
      const argsOut = args.map(arg => (/ |^$/.test(arg) ? `'${arg}'` : arg));
      this.logOutput(
        `${formatLogPrefix(startedAt, name, reason)} svn ${argsOut.join(" ")}\n`
      );
    }

    if (options.username) {
      args.push("--username", options.username);
    }
    if (options.password) {
      args.push("--password", options.password);
    }

    if (options.username || options.password) {
      // Configuration format: FILE:SECTION:OPTION=[VALUE]
      // Disable password store
      args.push("--config-option", "config:auth:password-stores=");
      // Disable store auth credentials
      args.push("--config-option", "servers:global:store-auth-creds=no");
    }

    // Force non interactive environment
    args.push("--non-interactive");

    const defaults: cp.SpawnOptions = {
      env: proc.env
    };
    if (cwd) {
      defaults.cwd = cwd;
    }

    defaults.env = Object.assign({}, proc.env, options.env || {}, {
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8"
    });

    const { exitCode, stdout, stderr } = await runSvnProcess(
      this.svnPath,
      args,
      defaults,
      options.signal
    );

    const duration = Date.now() - startedAt.getTime();
    if (options.log !== false && duration >= SLOW_COMMAND_LOG_MS) {
      const completedAt = new Date();
      this.logOutput(
        `${formatLogPrefix(
          completedAt,
          name,
          reason
        )} svn ${command} completed in ${formatDuration(duration)}\n`
      );
    }

    if (options.log !== false && stderr.length > 0) {
      const errorTime = new Date();
      const err = stderr
        .split(/\r?\n/)
        .filter((line: string) => line.trim().length > 0)
        .map(
          (line: string) =>
            `${formatLogPrefix(errorTime, name, reason)} ${line}`
        )
        .join("\n");
      if (err) {
        this.logOutput(err + "\n");
      }
    }

    if (exitCode) {
      return Promise.reject<BufferResult>(
        createSvnError(command, exitCode, stdout, stderr)
      );
    }

    return { exitCode, stdout, stderr };
  }

  public async getRepositoryRoot(path: string) {
    try {
      const result = await this.exec(
        path,
        ["info", "--xml"],
        {},
        "repository-detect"
      );

      const info = await parseInfoXml(result.stdout);
      this.initialRepositoryInfo.set(path, info);

      if (info && info.wcInfo && info.wcInfo.wcrootAbspath) {
        return info.wcInfo.wcrootAbspath;
      }

      // SVN 1.6 not has "wcroot-abspath"
      return path;
    } catch (error) {
      if (error instanceof SvnError) {
        throw error;
      }
      console.error(error);
      throw new Error("Unable to find repository root path");
    }
  }

  public async open(
    repositoryRoot: string,
    workspaceRoot: string
  ): Promise<Repository> {
    const info = this.initialRepositoryInfo.get(workspaceRoot);
    this.initialRepositoryInfo.delete(workspaceRoot);

    return new Repository(
      this,
      repositoryRoot,
      workspaceRoot,
      ConstructorPolicy.Async,
      info
    );
  }
}
