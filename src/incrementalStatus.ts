import * as path from "path";
import { Disposable, Uri } from "vscode";
import { IFileStatus, PropStatus, Status } from "./common/types";
import { stat } from "./fs";
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

interface FileSnapshot {
  exists: boolean;
  mtime?: number;
  ctime?: number;
  size?: number;
}

interface ExpectedFsEcho {
  snapshot: FileSnapshot;
  expiresAt: number;
}

interface RepositoryStateSnapshot {
  isIncomplete: boolean;
  needCleanUp: boolean;
}

interface IncrementalStatusState {
  statuses: IFileStatus[];
  pendingTargets?: string[];
  mutatingTargets?: string[];
  repositoryState?: RepositoryStateSnapshot;
  expectedFsEchoes: Map<string, ExpectedFsEcho>;
  fsTargets: Set<string>;
  svnRefreshPending: boolean;
}

interface WorkingCopyMutationState {
  active: number;
  suppressUntil: number;
}

const SELF_SVN_METADATA_GRACE_MS = 2000;
const SELF_FS_ECHO_GRACE_MS = 5000;
const workingCopyMutations = new Map<string, WorkingCopyMutationState>();

function pathApi(workspaceRoot: string) {
  return /^[a-zA-Z]:[\\/]/.test(workspaceRoot) || /^\\\\/.test(workspaceRoot)
    ? path.win32
    : path;
}

function workingCopyKey(root: string): string {
  const paths = pathApi(root);
  const resolved = paths.resolve(root);
  return /^[a-zA-Z]:[\\/]/.test(root) || /^\\\\/.test(root)
    ? resolved.toLowerCase()
    : resolved;
}

function beginWorkingCopyMutation(root: string): void {
  const key = workingCopyKey(root);
  const state = workingCopyMutations.get(key) || {
    active: 0,
    suppressUntil: 0
  };

  state.active += 1;
  workingCopyMutations.set(key, state);
}

function endWorkingCopyMutation(root: string): void {
  const key = workingCopyKey(root);
  const state = workingCopyMutations.get(key);
  if (!state) {
    return;
  }

  state.active = Math.max(0, state.active - 1);
  state.suppressUntil = Date.now() + SELF_SVN_METADATA_GRACE_MS;

  setTimeout(() => {
    const current = workingCopyMutations.get(key);
    if (
      current === state &&
      current.active === 0 &&
      Date.now() >= current.suppressUntil
    ) {
      workingCopyMutations.delete(key);
    }
  }, SELF_SVN_METADATA_GRACE_MS + 50);
}

function isSelfGeneratedSvnMetadataChange(root: string): boolean {
  const state = workingCopyMutations.get(workingCopyKey(root));
  return !!state && (state.active > 0 || Date.now() < state.suppressUntil);
}

function absolutePath(workspaceRoot: string, file: string): string {
  const paths = pathApi(workspaceRoot);
  return paths.isAbsolute(file)
    ? paths.resolve(file)
    : paths.resolve(workspaceRoot, file);
}

function absolutePathKey(workspaceRoot: string, file: string): string {
  const resolved = absolutePath(workspaceRoot, file);
  return /^[a-zA-Z]:[\\/]/.test(resolved) || /^\\\\/.test(resolved)
    ? resolved.toLowerCase()
    : resolved;
}

async function getFileSnapshot(file: string): Promise<FileSnapshot> {
  try {
    const fileStat = await stat(file);
    return {
      exists: true,
      mtime: fileStat.mtime.getTime(),
      ctime: fileStat.ctime.getTime(),
      size: fileStat.size
    };
  } catch {
    return { exists: false };
  }
}

export function fileSnapshotsEqual(
  expected: FileSnapshot,
  actual: FileSnapshot
): boolean {
  if (expected.exists !== actual.exists) {
    return false;
  }

  if (!expected.exists) {
    return true;
  }

  return (
    expected.mtime === actual.mtime &&
    expected.ctime === actual.ctime &&
    expected.size === actual.size
  );
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

export function isTargetCoveredByTargets(
  workspaceRoot: string,
  target: string,
  targets: string[]
): boolean {
  const relativeTarget = relativePath(workspaceRoot, target);
  return targets.some(operationTarget =>
    statusBelongsToTarget(workspaceRoot, relativeTarget, operationTarget)
  );
}

export function shouldPreserveRepositoryState(
  workspaceRoot: string,
  targets: string[]
): boolean {
  return !targets.some(
    target => normalizePath(relativePath(workspaceRoot, target)) === "."
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

export function preserveRepositoryStateInSnapshot(
  statuses: IFileStatus[],
  isIncomplete: boolean,
  needCleanUp: boolean
): IFileStatus[] {
  if (!isIncomplete && !needCleanUp) {
    return statuses;
  }

  return [
    ...statuses,
    {
      path: ".",
      status: isIncomplete ? Status.INCOMPLETE : Status.NORMAL,
      props: PropStatus.NONE,
      wcStatus: {
        locked: needCleanUp,
        switched: false
      }
    }
  ];
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

function captureRepositoryState(
  repository: Repository
): RepositoryStateSnapshot {
  return {
    isIncomplete: repository.isIncomplete,
    needCleanUp: repository.needCleanUp
  };
}

function getRepositoryStateForTargets(
  repository: Repository,
  targets: string[] | undefined
): RepositoryStateSnapshot | undefined {
  if (
    !targets ||
    !shouldPreserveRepositoryState(repository.workspaceRoot, targets)
  ) {
    return;
  }

  return captureRepositoryState(repository);
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
    expectedFsEchoes: new Map<string, ExpectedFsEcho>(),
    fsTargets: new Set<string>(),
    svnRefreshPending: false
  };

  const rememberFsEchoes = async (targets: string[]) => {
    await Promise.all(
      targets.map(async target => {
        const absoluteTarget = absolutePath(repository.workspaceRoot, target);
        const snapshot = await getFileSnapshot(absoluteTarget);
        state.expectedFsEchoes.set(
          absolutePathKey(repository.workspaceRoot, absoluteTarget),
          {
            snapshot,
            expiresAt: Date.now() + SELF_FS_ECHO_GRACE_MS
          }
        );
      })
    );
  };

  const consumeFsEcho = async (eventTarget: string): Promise<boolean> => {
    const key = absolutePathKey(repository.workspaceRoot, eventTarget);
    const expected = state.expectedFsEchoes.get(key);
    if (!expected) {
      return false;
    }

    if (Date.now() >= expected.expiresAt) {
      state.expectedFsEchoes.delete(key);
      return false;
    }

    const actual = await getFileSnapshot(
      absolutePath(repository.workspaceRoot, eventTarget)
    );
    state.expectedFsEchoes.delete(key);
    return fileSnapshotsEqual(expected.snapshot, actual);
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

      if (state.repositoryState) {
        return preserveRepositoryStateInSnapshot(
          state.statuses,
          state.repositoryState.isIncomplete,
          state.repositoryState.needCleanUp
        );
      }

      return state.statuses;
    } catch (_error) {
      const statuses = filterWorkspaceStatuses(
        repository.workspaceRoot,
        await originalGetStatus(params)
      );
      state.statuses = statuses;
      return statuses;
    }
  };

  const originals = new Map<string, (...args: any[]) => any>();

  const originalOnDidAnyFileChanged = (
    repository as any
  ).onDidAnyFileChanged.bind(repository);
  originals.set("onDidAnyFileChanged", originalOnDidAnyFileChanged);
  (repository as any).onDidAnyFileChanged = (...args: any[]) => {
    if (isSelfGeneratedSvnMetadataChange(repository.root)) {
      return;
    }

    return originalOnDidAnyFileChanged(...args);
  };

  const patchOperation = (
    name: string,
    getTargets: (...args: any[]) => string[]
  ) => {
    const original = (repository as any)[name].bind(repository);
    originals.set(name, original);

    (repository as any)[name] = async (...args: any[]) => {
      state.statuses = snapshotStatuses(repository);
      const targets = operationTargets(repository, getTargets(...args));
      state.pendingTargets = targets;
      state.mutatingTargets = targets;
      state.repositoryState = getRepositoryStateForTargets(repository, targets);

      if (targets) {
        beginWorkingCopyMutation(repository.root);
      }

      let succeeded = false;
      try {
        const result = await original(...args);
        succeeded = true;
        return result;
      } finally {
        state.pendingTargets = undefined;
        state.repositoryState = undefined;
        if (succeeded && targets) {
          await rememberFsEchoes(targets);
        }
        state.mutatingTargets = undefined;
        if (targets) {
          endWorkingCopyMutation(repository.root);
        }
        if (succeeded && targets) {
          try {
            await svnRepository.updateInfo();
          } catch (error) {
            console.error(error);
          }
          repository.notifyRepositoryChanged(Uri.file(repository.root));
        }
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

  const collectFsTarget = async (
    target: string,
    eventTarget: string = target
  ) => {
    const autorefresh = configuration.get<boolean>("autorefresh");
    if (!autorefresh) {
      return;
    }

    if (!isTargetInWorkspace(repository.workspaceRoot, target)) {
      return;
    }

    if (
      state.mutatingTargets &&
      isTargetCoveredByTargets(
        repository.workspaceRoot,
        eventTarget,
        state.mutatingTargets
      )
    ) {
      return;
    }

    if (await consumeFsEcho(eventTarget)) {
      return;
    }

    state.fsTargets.add(target);
    (repository as any).eventuallyUpdateWhenIdleAndWait();
  };

  const collectSvnChange = () => {
    const autorefresh = configuration.get<boolean>("autorefresh");
    if (
      !autorefresh ||
      !repository.operations.isIdle() ||
      isSelfGeneratedSvnMetadataChange(repository.root)
    ) {
      return;
    }

    state.svnRefreshPending = true;
  };

  let fsDisposables: Disposable[] = [];
  fsDisposables.push(
    repository.fsWatcher.onDidWorkspaceChange(uri => {
      void collectFsTarget(uri.fsPath);
    }),
    repository.fsWatcher.onDidWorkspaceCreate(uri => {
      void collectFsTarget(uri.fsPath);
    }),
    repository.fsWatcher.onDidWorkspaceDelete(uri => {
      void collectFsTarget(path.dirname(uri.fsPath), uri.fsPath);
    }),
    repository.fsWatcher.onDidSvnAny(collectSvnChange)
  );

  const originalEventuallyUpdate = (
    repository as any
  ).eventuallyUpdateWhenIdleAndWait.bind(repository);
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

  const originalUpdateWhenIdleAndWait = (
    repository as any
  ).updateWhenIdleAndWait.bind(repository);
  originals.set("updateWhenIdleAndWait", originalUpdateWhenIdleAndWait);
  (repository as any).updateWhenIdleAndWait = async () => {
    await repository.whenIdleAndFocused();

    if (!state.fsTargets.size && !state.svnRefreshPending) {
      return;
    }

    await (repository as any).status();
  };

  const originalStatus = repository.status.bind(repository);
  originals.set("status", originalStatus);
  (repository as any).status = async () => {
    if (state.svnRefreshPending) {
      state.svnRefreshPending = false;
      state.fsTargets.clear();
      state.pendingTargets = undefined;
      state.repositoryState = undefined;
    } else if (state.fsTargets.size) {
      state.statuses = snapshotStatuses(repository);
      state.pendingTargets = Array.from(state.fsTargets);
      state.repositoryState = getRepositoryStateForTargets(
        repository,
        state.pendingTargets
      );
      state.fsTargets.clear();
    }

    try {
      return await originalStatus();
    } finally {
      state.pendingTargets = undefined;
      state.repositoryState = undefined;
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
