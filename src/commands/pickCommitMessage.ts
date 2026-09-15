import { QuickPickItem, window } from "vscode";
import { Repository } from "../repository";
import { Command } from "./command";
import { logLimit } from "../helpers/settingValues";
import { configuration } from "../helpers/configuration";
import * as semver from "semver";
import { ISvnLogEntry } from "../common/types";
import { selectWorkingCopyScope } from "./workingCopyScopes";

export class PickCommitMessage extends Command {
  constructor(private svnVersion: string) {
    super("svn.pickCommitMessage", { repository: true });
  }

  public async execute(repository: Repository, hint?: unknown) {
    if (hint === repository.sourceControl) {
      const scope = await selectWorkingCopyScope(
        repository,
        "Choose an opened folder to load commit messages"
      );
      if (!scope) return;
      repository = scope;
    }
    const is18orGreater = semver.satisfies(this.svnVersion, ">= 1.8");
    let logs: ISvnLogEntry[] = [];
    const user = configuration.get("previousCommitsUser", null);
    if (user && is18orGreater) {
      logs = await repository.logByUser(user);
    } else {
      logs = await repository.log(
        "HEAD",
        "0",
        logLimit(configuration.get("log.length"))
      );
    }

    if (!logs.length) {
      return;
    }

    const picks: QuickPickItem[] = logs.map(l => {
      return {
        label: l.msg,
        description: `r${l.revision} | ${l.author} | ${new Date(
          l.date
        ).toLocaleString()}`
      };
    });

    const selected = await window.showQuickPick(picks);

    if (selected === undefined) {
      return;
    }

    const msg = selected.label;

    repository.inputBox.value = msg;

    return msg;
  }
}
