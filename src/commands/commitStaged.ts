import * as path from "path";
import { window } from "vscode";
import { Status } from "../common/types";
import { refreshStatusTargets } from "../incrementalStatus";
import { inputCommitMessage, noChangesToCommit } from "../messages";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { StagingCoordinator } from "../stagingCoordinator";
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

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

async function validatedStagedEntries(
  staging: StagingCoordinator,
  repository: Repository
): Promise<CommitEntry[]> {
  const candidates = staging.stagedEntriesForWorkingCopy(repository);
  if (!candidates.length) {
    return [];
  }

  const validated = await staging.validateUnstageSelection(
    candidates.map(({ resource }) => resource)
  );
  const validatedPaths = new Set(
    validated.map(resource => normalizePath(resource.resourceUri.fsPath))
  );

  return staging
    .stagedEntriesForWorkingCopy(repository)
    .filter(
      ({ resource }) =>
        resource.type !== Status.CONFLICTED &&
        validatedPaths.has(normalizePath(resource.resourceUri.fsPath))
    )
    .map(({ repository: owner, resource, changelist }) => ({
      repository: owner,
      resource,
      changelist
    }));
}

function isAddedSnapshotPath(
  repository: Repository,
  filePath: string
): boolean {
  const key = normalizePath(filePath);
  return (repository.getStatusSnapshot() ?? []).some(status => {
    const statusPath = path.isAbsolute(status.path)
      ? status.path
      : path.resolve(repository.workspaceRoot, status.path);
    return normalizePath(statusPath) === key && status.status === Status.ADDED;
  });
}

async function refreshPeerProjections(
  staging: StagingCoordinator,
  anchor: Repository,
  paths: string[]
): Promise<void> {
  await Promise.all(
    staging
      .repositoriesForWorkingCopy(anchor)
      .filter(peer => peer !== anchor)
      .map(peer => {
        const targets = paths.filter(filePath =>
          isPathInside(peer.workspaceRoot, filePath)
        );
        return targets.length
          ? refreshStatusTargets(peer, targets)
          : Promise.resolve();
      })
  );
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
      if (
        parent?.type === Status.ADDED ||
        isAddedSnapshotPath(repository, dir)
      ) {
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
    await refreshPeerProjections(staging, anchor, commitPaths);
    window.showInformationMessage(result);
    staging.clearInputBoxes(anchor);
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
    await commitEntries(
      repository,
      await validatedStagedEntries(this.staging, repository),
      this.staging
    );
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
