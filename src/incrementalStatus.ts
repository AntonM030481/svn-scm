import * as path from "path";
import { Disposable } from "vscode";
import { IFileStatus, PropStatus, Status } from "./common/types";
import { configuration } from "./helpers/configuration";
import { parseStatusXml } from "./parser/statusParser";
import { Repository } from "./repository";
import { Resource } from "./resource";
import { SourceControlManager } from "./source_control_manager";
import { Repository as SvnRepository } from "./svnRepository";
import { dispose, isDescendant, normalizePath, toDisposable } from "./util";

interface StatusParams {
  includeIgnored?: boolean;
  includeExternals?: boolean;
  checkRemoteChanges?: boolean;
}

interface IncrementalStatusState {
  statuses: IFileStatus[];
  pendingTargets?: string[];
  fsTargets: Set<string>;
  svnRefreshPending: boolean;
}

function pathApi(workspaceRoot: string) {
  return /^[a-zA-Z]:[\\/]/.test(workspaceRoot) || /^\\\\/.test(workspaceRoot)
    ? path.win32
    : path;
}

function absolutePath(workspaceRoot: string, file: string): string {
  const paths = pathApi(workspaceRoot);
  return paths.isAbsolute(file)
    ? paths.resolve(file)
    : paths.resolve(workspaceRoot, file);
}

export function isTargetInWorkspace(
  workspaceRoot: string,
  target: string
): boolean {
  const paths = pathApi(workspaceRoot);
  const root = paths.resolve(workspaceRoot);
  const targetPath = absolutePath(workspaceRoot, target);
  const relative = paths.relative(root, targetPath);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative))
  );
}

function relativePath(workspaceRoot: string, file: string): string {
  const paths = pathApi(workspaceRoot);
  if (!paths.isAbsolute(file)) {
    return file;
  }

  const relative = paths.relative(workspaceRoot, file);
  return relative || ".";
}

function statusBelongsToTarget(
  workspaceRoot: string,
  statusPath: string,
  target: string
): boolean {
  if (!isTargetInWorkspace(workspaceRoot, target)) {
    return false;
  }

  const normalizedStatus = normalizePath(statusPath);
  const normalizedTarget = normalizePath(relativePath(workspaceRoot, target));

  return (
    normalizedTarget === "." ||
    normalizedStatus === normalizedTarget ||
    isDescendant(normalizedTarget, normalizedStatus)
  );
}

function filterWorkspaceStatuses(
  workspaceRoot: string,
  statuses: IFileStatus[]
): IFileStatus[] {
  return statuses.filter(status =>
    isTargetInWorkspace(workspaceRoot, status.path)
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
  const statuses: IFileStatus[] = filterWorkspaceStatuses(
    repository.workspaceRoot,
    [...repository.statusExternal, ...repository.statusIgnored]
  );

  const append = (resources: Resource[], changelist?: string) => {
    resources
      .filter(resource =>
        isTargetInWorkspace(
          repository.workspaceRoot,
          resource.resourceUri.fsPath
        )
      )
      .forEach(resource => {
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
  if (
    targets.some(
      target => !isTargetInWorkspace(repository.workspaceRoot, target)
    )
  ) {
    throw new Error("Incremental status target is outside workspace root");
  }

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

  return filterWorkspaceStatuses(repository.workspaceRoot, statuses);
}

export function mergeStatuses(
  workspaceRoot: string,
  current: IFileStatus[],
  targets: string[],
  updated: IFileStatus[]
): IFileStatus[] {
  const statuses = filterWorkspaceStatuses(workspaceRoot, current).filter(
    status =>
      !targets.some(target =>
        statusBelongsToTarget(workspaceRoot, status.path, target)
      )
  );

  const byPath = new Map<string, IFileStatus>();
  statuses.forEach(status => byPath.set(normalizePath(status.path), status));
  filterWorkspaceStatuses(workspaceRoot, updated).forEach(status =>
    byPath.set(normalizePath(status.path), status)
  );

  return Array.from(byPath.values());
}

function targetList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(item => typeof item === "string") as string[];
}

function operationTargets(
  repository: Repository,
  targets: string[]
): string[] | undefined {
  if (!targets.length) {
    return undefined;
  }

  return targets.every(target =>
    isTargetInWorkspace(repository.workspaceRoot, target)
  )
    ? targets
    : undefined;
}

function patchRepository(repository: Repository): Disposable {
  const svnRepository = repository.repository;
  const originalGetStatus = svnRepository.getStatus.bind(svnRepository);
  const state: IncrementalStatusState = {
    statuses: snapshotStatuses(repository),
    fsTargets: new Set<string>(),
    svnRefreshPending: false
  };

  svnRepository.getStatus = async (params: StatusParams) => {
    const targets = state.pendingTargets;

    if (!targets || !targets.length || params.checkRemoteChanges) {
      const statuses = filterWorkspaceStatuses(
        repository.workspaceRoot,
        await originalGetStatus(params)
      );
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
      const statuses = filterWorkspaceStatuses(
        repository.workspaceRoot,
        await originalGetStatus(params)
      );
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
      state.statuses = snapshotStatuses(repository);
      state.pendingTargets = operationTargets(repository, getTargets(...args));

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

  const collectFsTarget = (target: string) => {
    const autorefresh = configuration.get<boolean>("autorefresh");
    if (!autorefresh || !repository.operations.isIdle()) {
      return;
    }

    if (!isTargetInWorkspace(repository.workspaceRoot, target)) {
      return;
    }

    state.fsTargets.add(target);
  };

  const collectSvnChange = () => {
    const autorefresh = configuration.get<boolean>("autorefresh");
    if (!autorefresh || !repository.operations.isIdle()) {
      return;
    }

    state.svnRefreshPending = true;
  };

  let fsDisposables: Disposable[] = [];
  fsDisposables.push(
    repository.fsWatcher.onDidWorkspaceChange(uri =>
      collectFsTarget(uri.fsPath)
    ),
    repository.fsWatcher.onDidWorkspaceCreate(uri =>
      collectFsTarget(uri.fsPath)
    ),
    repository.fsWatcher.onDidWorkspaceDelete(uri =>
      collectFsTarget(path.dirname(uri.fsPath))
    ),
    repository.fsWatcher.onDidSvnAny(collectSvnChange)
  );

  const originalEventuallyUpdate = (repository as any).eventuallyUpdateWhenIdleAndWait.bind(
    repository
  );
  originals.set("eventuallyUpdateWhenIdleAndWait", originalEventuallyUpdate);

  let fsRefreshCheckScheduled = false;
  (repository as any).eventuallyUpdateWhenIdleAndWait = () => {
    if (fsRefreshCheckScheduled) {
      return;
    }

    fsRefreshCheckScheduled = true;
    setTimeout(() => {
      fsRefreshCheckScheduled = false;

      if (state.fsTargets.size || state.svnRefreshPending) {
        originalEventuallyUpdate();
      }
    }, 0);
  };

  const originalStatus = repository.status.bind(repository);
  originals.set("status", originalStatus);
  (repository as any).status = async () => {
    if (state.svnRefreshPending) {
      state.svnRefreshPending = false;
      state.fsTargets.clear();
      state.pendingTargets = undefined;
    } else if (state.fsTargets.size) {
      state.statuses = snapshotStatuses(repository);
      state.pendingTargets = Array.from(state.fsTargets);
      state.fsTargets.clear();
    }

    try {
      return await originalStatus();
    } finally {
      state.pendingTargets = undefined;
    }
  };

  return toDisposable(() => {
    svnRepository.getStatus = originalGetStatus;
    originals.forEach((original, name) => {
      (repository as any)[name] = original;
    });
    fsDisposables = dispose(fsDisposables);
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
