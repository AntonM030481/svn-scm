import * as path from "path";
import { window } from "vscode";
import { Status } from "../common/types";
import { inputCommitMessage, noChangesToCommit } from "../messages";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { StagingCoordinator } from "../stagingCoordinator";
import { isStagingChangelist } from "../stagingModel";
import SvnError, { getErrorMessage } from "../svnError";
import { normalizePath } from "../util";
import { Command } from "./command";

interface CommitEntry {
  repository: Repository;
  resource: Resource;
  changelist?: string;
}

function uniquePaths(paths: string[]): string[] {
  const result = new Map<string, string>();
  for (const filePath of paths) {
    result.set(normalizePath(filePath), filePath);
  }
  return [...result.values()];
}

async function ensureWorkingCopyLiveStatus(
  staging: StagingCoordinator,
  repository: Repository
): Promise<void> {
  await Promise.all(
    staging
      .repositoriesForWorkingCopy(repository)
      .map(peer => peer.fullStatus())
  );
}

async function authoritativeStagedPaths(
  staging: StagingCoordinator,
  repository: Repository
): Promise<Map<Repository, Set<string>>> {
  const result = new Map<Repository, Set<string>>();
  await Promise.all(
    staging.repositoriesForWorkingCopy(repository).map(async peer => {
      const statuses = await peer.repository.getStatus({
        includeIgnored: true,
        includeExternals: false,
        forceFull: true
      });
      const paths = new Set<string>();
      for (const status of statuses) {
        if (!status.changelist || !isStagingChangelist(status.changelist)) {
          continue;
        }
        const filePath = path.isAbsolute(status.path)
          ? status.path
          : path.resolve(peer.workspaceRoot, status.path);
        paths.add(normalizePath(filePath));
      }
      result.set(peer, paths);
    })
  );
  return result;
}

async function commitEntries(
  anchor: Repository,
  entries: CommitEntry[],
  staging: StagingCoordinator
): Promise<void> {
  if (!entries.length) {
    await noChangesToCommit();
    return;
  }

  const paths: string[] = [];
  for (const { repository, resource } of entries) {
    paths.push(resource.resourceUri.fsPath);

    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      paths.push(resource.renameResourceUri.fsPath);
    }

    let dir = path.dirname(resource.resourceUri.fsPath);
    while (
      dir !== path.dirname(dir) &&
      normalizePath(dir) !== normalizePath(repository.root)
    ) {
      const parent = staging.findResource(repository, dir);
      if (parent?.type === Status.ADDED) {
        paths.push(dir);
      }
      dir = path.dirname(dir);
    }
  }

  const commitPaths = uniquePaths(paths);
  const message = await inputCommitMessage(
    anchor.inputBox.value,
    false,
    commitPaths
  );
  if (message === undefined) {
    return;
  }

  try {
    const result = await anchor.commitFiles(message, commitPaths);
    await staging.finalizeCommitted(entries);
    window.showInformationMessage(result);
    staging.clearInputBoxes(anchor);
    await staging.refreshWorkingCopy(anchor);
  } catch (error) {
    console.error(error);
    window.showErrorMessage(
      error instanceof SvnError ? error.displayMessage : getErrorMessage(error)
    );
  }
}

export class CommitStaged extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.commitStaged", { repository: true });
  }

  public async execute(repository: Repository) {
    await ensureWorkingCopyLiveStatus(this.staging, repository);
    const currentStagedPaths = await authoritativeStagedPaths(
      this.staging,
      repository
    );
    const entries = this.staging
      .stagedEntriesForWorkingCopy(repository)
      .filter(({ repository: owner, resource }) =>
        currentStagedPaths
          .get(owner)
          ?.has(normalizePath(resource.resourceUri.fsPath))
      )
      .map(({ repository: owner, resource, changelist }) => ({
        repository: owner,
        resource,
        changelist
      }));
    await commitEntries(repository, entries, this.staging);
  }
}

export class CommitAll extends Command {
  constructor(private readonly staging: StagingCoordinator) {
    super("svn.commitAll", { repository: true });
  }

  public async execute(repository: Repository) {
    await ensureWorkingCopyLiveStatus(this.staging, repository);
    await commitEntries(
      repository,
      this.staging.allCommittableEntriesForWorkingCopy(repository),
      this.staging
    );
  }
}
