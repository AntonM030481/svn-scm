import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import type { Memento } from "vscode";
import { IFileStatus, Status } from "./common/types";

export const STARTUP_MAX_FILES = 50;
export const STARTUP_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const STARTUP_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface StatusSnapshot {
  version: 1;
  identity: string;
  statuses: IFileStatus[];
}

// Use the native path rules: snapshots never migrate between operating systems.
export function snapshotPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSnapshotPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !/^[a-z]:/i.test(value) &&
    !value
      .split(/[\\/]/)
      .some(part => part === ".." || part === ".svn" || part === "_svn")
  );
}

function isStatus(value: unknown): value is IFileStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as IFileStatus;
  return (
    isSnapshotPath(s.path) &&
    Object.values(Status).includes(s.status as Status) &&
    typeof s.props === "string" &&
    !!s.wcStatus &&
    typeof s.wcStatus.locked === "boolean" &&
    typeof s.wcStatus.switched === "boolean" &&
    (s.rename === undefined || isSnapshotPath(s.rename)) &&
    (s.changelist === undefined || typeof s.changelist === "string") &&
    (s.repositoryUuid === undefined || typeof s.repositoryUuid === "string") &&
    (s.reposStatus === undefined ||
      (!!s.reposStatus &&
        typeof s.reposStatus.item === "string" &&
        typeof s.reposStatus.props === "string"))
  );
}

export function readStatusSnapshot(
  value: unknown,
  identity: string
): IFileStatus[] | undefined {
  if (!value || typeof value !== "object") return;
  const snapshot = value as StatusSnapshot;
  if (
    snapshot.version !== 1 ||
    snapshot.identity !== identity ||
    !Array.isArray(snapshot.statuses) ||
    snapshot.statuses.length > 50000 ||
    !snapshot.statuses.every(isStatus)
  )
    return;
  const keys = snapshot.statuses.map(s => snapshotPathKey(s.path));
  if (new Set(keys).size !== keys.length) return;
  return snapshot.statuses;
}

/** A workspace-scoped, bounded snapshot. Memento owns durable atomic storage. */
export class StatusSnapshotStore {
  private readonly key: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: Memento,
    root: string,
    workspaceRoot: string
  ) {
    this.key =
      "svn.statusSnapshot." +
      createHash("sha256")
        .update(
          JSON.stringify([
            snapshotPathKey(root),
            snapshotPathKey(workspaceRoot)
          ])
        )
        .digest("hex");
  }

  read(identity: string): IFileStatus[] | undefined {
    return readStatusSnapshot(this.state.get<unknown>(this.key), identity);
  }

  write(identity: string, statuses: IFileStatus[]): Promise<void> {
    // Strip accidental extension fields and detach from mutable live objects.
    const snapshot: StatusSnapshot = {
      version: 1,
      identity,
      statuses: statuses.map(s => ({
        path: s.path,
        status: s.status,
        props: s.props,
        wcStatus: { ...s.wcStatus },
        changelist: s.changelist,
        rename: s.rename,
        repositoryUuid: s.repositoryUuid,
        reposStatus: s.reposStatus && {
          item: s.reposStatus.item,
          props: s.reposStatus.props
        }
      }))
    };
    const valid = readStatusSnapshot(snapshot, identity);
    const value =
      valid && Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES
        ? snapshot
        : undefined;
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => this.state.update(this.key, value));
    return this.writes;
  }
}

/** Directory identity changes on a replacement checkout, not on ordinary edits. */
export async function workingCopyIdentity(
  root: string,
  workspaceRoot: string,
  uuid: string,
  url: string,
  adminDir: string
): Promise<string> {
  const metadata = await fs.stat(path.join(root, adminDir));
  return JSON.stringify([
    snapshotPathKey(root),
    snapshotPathKey(workspaceRoot),
    uuid,
    url,
    metadata.dev,
    metadata.ino,
    metadata.birthtimeMs
  ]);
}

export async function selectStartupTargets(
  workspaceRoot: string,
  statuses: IFileStatus[]
): Promise<string[]> {
  const candidates = statuses.filter(
    s =>
      s.path !== "." &&
      s.status !== Status.EXTERNAL &&
      s.status !== Status.IGNORED &&
      ((s.status !== Status.NORMAL && s.status !== Status.NONE) ||
        (s.props !== Status.NORMAL && s.props !== Status.NONE) ||
        !!s.changelist)
  );
  if (candidates.length > STARTUP_MAX_FILES) return [];
  const targets: string[] = [];
  let bytes = 0;
  const realRoot = await fs.realpath(workspaceRoot);
  for (const status of [...candidates].sort((a, b) =>
    a.path < b.path ? -1 : 1
  )) {
    // Rename pairs and external descendants require the full reconciliation.
    if (
      !isSnapshotPath(status.path) ||
      status.rename ||
      statuses.some(
        s =>
          s.status === Status.EXTERNAL &&
          (status.path === s.path || status.path.startsWith(s.path + path.sep))
      )
    )
      continue;
    try {
      const absolute = path.join(workspaceRoot, status.path);
      const stat = await fs.lstat(absolute);
      if (
        !stat.isFile() ||
        stat.size > STARTUP_MAX_FILE_BYTES ||
        bytes + stat.size > STARTUP_MAX_TOTAL_BYTES
      )
        continue;
      const relative = path.relative(realRoot, await fs.realpath(absolute));
      if (!isSnapshotPath(relative)) continue;
      targets.push(status.path);
      bytes += stat.size;
    } catch {
      // Missing targets and metadata errors retain their saved state until full status.
    }
  }
  return targets;
}

/** --verbose makes clean checked files explicit; absent results prove nothing. */
export function mergeStartupStatus(
  saved: IFileStatus[],
  targets: string[],
  updated: IFileStatus[]
): IFileStatus[] {
  const selected = new Set(targets.map(snapshotPathKey));
  const byPath = new Map(saved.map(s => [snapshotPathKey(s.path), s]));
  for (const status of updated) {
    const key = snapshotPathKey(status.path);
    if (!selected.has(key) || !isStatus(status)) continue;
    const previous = byPath.get(key);
    byPath.set(key, { ...status, reposStatus: previous?.reposStatus });
  }
  return [...byPath.values()];
}
