import * as path from "path";
import { Disposable } from "vscode";
import { IFileStatus, PropStatus, Status } from "./common/types";
import { parseStatusXml } from "./parser/statusParser";
import { Repository } from "./repository";
import { Resource } from "./resource";
import { SourceControlManager } from "./source_control_manager";
import { Repository as SvnRepository } from "./svnRepository";
import { isDescendant, normalizePath, toDisposable } from "./util";

interface StatusParams {
  includeIgnored?: boolean;
  includeExternals?: boolean;
  checkRemoteChanges?: boolean;
}

interface IncrementalStatusState {
  statuses: IFileStatus[];
  pendingTargets?: string[];
}

function relativePath(workspaceRoot: string, file: string): string {
  if (!path.isAbsolute(file)) {
    return file;
  }

  const relative = path.relative(workspaceRoot, file);
  return relative || ".";
}

function statusBelongsToTarget(
  workspaceRoot: string,
  statusPath: string,
  target: string
): boolean {
  const normalizedStatus = normalizePath(statusPath);
  const normalizedTarget = normalizePath(relativePath(workspaceRoot, target));

  return (
    normalizedTarget === "." ||
    normalizedStatus === normalizedTarget ||
    isDescendant(normalizedTarget, normalizedStatus)
  );
}

function resourceToStatus(
  repository: Repository,
  resource: Resource,
  changelist?: string
): IFileStatus {
  const rename = resource.renameResourceUri
    ? relativePath(repository.workspaceRoot, resource.renameResourceUri.fsPath)
    : undefined;

  return {
    changelist,
    path: relativePath(repository.workspaceRoot, resource.resourceUri.fsPath),
    status: resource.type,
    props: resource.props || PropStatus.NONE,
    rename,
    wcStatus: {
      locked: false,
      switched: false
    }
  };
}

function snapshotStatuses(repository: Repository): IFileStatus[] {
  const statuses: IFileStatus[] = [
    ...repository.statusExternal,
    ...repository.statusIgnored
  ];

  const append = (resources: Resource[], changelist?: string) => {
    resources.forEach(resource => {
      statuses.push(resourceToStatus(repository, resource, changelist));
    });
  };

  append(repository.changes.resourceStates);
  append(repository.conflicts.resourceStates);
  append(repository.unversioned.resourceStates);
  repository.changelists.forEach((group, changelist) => {
    append(group.resourceStates, changelist);
  });

  return statuses;
}

async function getTargetedStatus(
  repository: SvnRepository,
  params: StatusParams,
  targets: string[]
): Promise<IFileStatus[]> {
  const args = ["stat", "--xml"];

  if (params.includeIgnored) {
    args.push("--no-ignore");
  }
  if (params.includeExternals === false) {
    args.push("--ignore-externals");
  }
  if (params.checkRemoteChanges) {
    args.push("--show-updates");
  }

  args.push(
    ...targets.map(target =>
      path.isAbsolute(target) ? repository.removeAbsolutePath(target) : target
    )
  );

  const result = await repository.exec(args);
  const statuses = await parseStatusXml(result.stdout);

  for (const status of statuses) {
    if (status.status !== Status.EXTERNAL) {
      continue;
    }

    try {
      const info = await repository.getInfo(status.path);
      status.repositoryUuid = info.repository.uuid;
    } catch (error) {
      console.error(error);
    }
  }

  return statuses;
}

function mergeStatuses(
  workspaceRoot: string,
  current: IFileStatus[],
  targets: string[],
  updated: IFileStatus[]
): IFileStatus[] {
  const statuses = current.filter(
    status =>
      !targets.some(target =>
        statusBelongsToTarget(workspaceRoot, status.path, target)
      )
  );

  const byPath = new Map<string, IFileStatus>();
  statuses.forEach(status => byPath.set(normalizePath(status.path), status));
  updated.forEach(status => byPath.set(normalizePath(status.path), status));

  return Array.from(byPath.values());
}

function targetList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(item => typeof item === "string") as string[];
}

function patchRepository(repository: Repository): Disposable {
  const svnRepository = repository.repository;
  const originalGetStatus = svnRepository.getStatus.bind(svnRepository);
  const state: IncrementalStatusState = {
    statuses: snapshotStatuses(repository)
  };

  svnRepository.getStatus = async (params: StatusParams) => {
    const targets = state.pendingTargets;

    if (!targets || !targets.length || params.checkRemoteChanges) {
      const statuses = await originalGetStatus(params);
      state.statuses = statuses;
      return statuses;
    }

    state.pendingTargets = undefined;

    try {
      const updated = await getTargetedStatus(svnRepository, params, targets);
      state.statuses = mergeStatuses(
        repository.workspaceRoot,
        state.statuses,
        targets,
        updated
      );
      return state.statuses;
    } catch (error) {
      // A targeted status can fail for paths that disappeared or changed shape.
      // Fall back to the existing full scan to preserve correctness.
      const statuses = await originalGetStatus(params);
      state.statuses = statuses;
      return statuses;
    }
  };

  const originals = new Map<string, (...args: any[]) => any>();

  const patchOperation = (
    name: string,
    getTargets: (...args: any[]) => string[]
  ) => {
    const original = (repository as any)[name].bind(repository);
    originals.set(name, original);

    (repository as any)[name] = async (...args: any[]) => {
      state.pendingTargets = getTargets(...args);

      try {
        return await original(...args);
      } finally {
        state.pendingTargets = undefined;
      }
    };
  };

  patchOperation("addFiles", files => targetList(files));
  patchOperation("addChangelist", files => targetList(files));
  patchOperation("removeChangelist", files => targetList(files));
  patchOperation("resolve", files => targetList(files));
  patchOperation("commitFiles", (_message, files) => targetList(files));
  patchOperation("revert", files => targetList(files));
  patchOperation("removeFiles", files => targetList(files));
  patchOperation("pullIncomingChange", file =>
    typeof file === "string" ? [file] : []
  );
  patchOperation("addToIgnore", (_expressions, directory) =>
    typeof directory === "string" ? [directory] : []
  );
  patchOperation("rename", (oldFile, newFile) =>
    [oldFile, newFile].filter(file => typeof file === "string")
  );

  return toDisposable(() => {
    svnRepository.getStatus = originalGetStatus;
    originals.forEach((original, name) => {
      (repository as any)[name] = original;
    });
  });
}

export function enableIncrementalStatusRefresh(
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
