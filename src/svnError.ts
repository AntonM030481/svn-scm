import { ISvnErrorData } from "./common/types";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : String(error);
}

export default class SvnError extends Error {
  public error?: Error;
  public stdout?: string;
  public stderr?: string;
  public stderrFormated?: string;
  public exitCode?: number;
  public svnErrorCode?: string;
  public svnCommand?: string;

  constructor(data: ISvnErrorData) {
    super(data.message || "SVN error");
    this.name = "SvnError";
    this.error = data.error;
    this.stdout = data.stdout;
    this.stderr = data.stderr;
    this.stderrFormated = data.stderrFormated;
    this.exitCode = data.exitCode;
    this.svnErrorCode = data.svnErrorCode;
    this.svnCommand = data.svnCommand;
  }

  public get displayMessage(): string {
    return this.stderrFormated || this.stderr || this.message;
  }

  public toString(): string {
    let result =
      this.message +
      " " +
      JSON.stringify(
        {
          exitCode: this.exitCode,
          svnErrorCode: this.svnErrorCode,
          svnCommand: this.svnCommand,
          stdout: this.stdout,
          stderr: this.stderr
        },
        null,
        2
      );

    if (this.error?.stack) {
      result += this.error.stack;
    }

    return result;
  }
}
