import { Disposable } from "vscode";
import { ICpOptions, Operation } from "./common/types";
import { Repository } from "./repository";
import { SourceControlManager } from "./source_control_manager";
import { toDisposable } from "./util";

export function getTargetedStatusLogReason(
  args: string[],
  statusOperationRunning: boolean,
  operationsIdle: boolean
): string | undefined {
  const command = (args[0] || "").toLowerCase();
  if (command !== "stat" && command !== "status") {
    return;
  }

  if (args.includes("--show-updates")) {
    return;
  }

  const hasTarget = args
    .slice(1)
    .some(arg => typeof arg === "string" && !arg.startsWith("-"));
  if (!hasTarget) {
    return;
  }

  if (statusOperationRunning) {
    return "fs-change";
  }

  if (!operationsIdle) {
    return "svn-operation";
  }

  return;
}

function patchRepository(repository: Repository): Disposable {
  const svnRepository = repository.repository;
  const originalExec = svnRepository.exec.bind(svnRepository);

  svnRepository.exec = (args: string[], options: ICpOptions = {}) => {
    const reason = getTargetedStatusLogReason(
      args,
      repository.operations.isRunning(Operation.Status),
      repository.operations.isIdle()
    );

    if (!reason || options.logReason) {
      return originalExec(args, options);
    }

    return originalExec(args, { ...options, logReason: reason });
  };

  return toDisposable(() => {
    svnRepository.exec = originalExec;
  });
}

export function enableTargetedStatusLogReasons(
  sourceControlManager: SourceControlManager,
  disposables: Disposable[]
): void {
  const patched = new WeakSet<Repository>();

  const patch = (repository: Repository) => {
    if (patched.has(repository)) {
      return;
    }

    patched.add(repository);
    disposables.push(patchRepository(repository));
  };

  sourceControlManager.repositories.forEach(patch);
  disposables.push(sourceControlManager.onDidOpenRepository(patch));
}
