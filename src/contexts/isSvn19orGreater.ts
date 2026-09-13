import { Disposable } from "vscode";
import * as semver from "semver";
import { setVscodeContext } from "../util";

export class IsSvn19orGreater implements Disposable {
  readonly initialized: Promise<void>;
  constructor(svnVersion: string) {
    const is19orGreater = semver.satisfies(svnVersion, ">= 1.9");

    this.initialized = Promise.resolve(
      setVscodeContext("isSvn19orGreater", is19orGreater)
    );
  }

  dispose() {
    void Promise.resolve(setVscodeContext("isSvn19orGreater", false)).catch(
      console.error
    );
  }
}
