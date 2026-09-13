import { Disposable } from "vscode";
import * as semver from "semver";
import { setVscodeContext } from "../util";

export class IsSvn18orGreater implements Disposable {
  readonly initialized: Promise<void>;
  constructor(svnVersion: string) {
    const is18orGreater = semver.satisfies(svnVersion, ">= 1.8");

    this.initialized = Promise.resolve(
      setVscodeContext("isSvn18orGreater", is18orGreater)
    );
  }

  dispose() {
    void Promise.resolve(setVscodeContext("isSvn18orGreater", false)).catch(
      console.error
    );
  }
}
