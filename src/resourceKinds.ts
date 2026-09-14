import * as path from "path";
import { IFileStatus, Status } from "./common/types";
import { lstat } from "./fs";

const directoryPaths = new Set<string>();
const MAX_STAT_CONCURRENCY = 16;

function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function absolutePath(workspaceRoot: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

function clearWorkspace(workspaceRoot: string): void {
  const root = key(workspaceRoot);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;

  for (const file of directoryPaths) {
    if (file === root || file.startsWith(prefix)) {
      directoryPaths.delete(file);
    }
  }
}

export function isUnversionedDirectory(file: string): boolean {
  return directoryPaths.has(key(file));
}

export async function updateUnversionedDirectoryKinds(
  workspaceRoot: string,
  statuses: IFileStatus[]
): Promise<void> {
  const unversioned = statuses.filter(
    status => status.status === Status.UNVERSIONED
  );
  let next = 0;

  const worker = async () => {
    while (next < unversioned.length) {
      const status = unversioned[next++];
      const file = absolutePath(workspaceRoot, status.path);
      const fileKey = key(file);
      directoryPaths.delete(fileKey);

      try {
        if ((await lstat(file)).isDirectory()) {
          directoryPaths.add(fileKey);
        }
      } catch {
        // The path may disappear between `svn status` and the async stat.
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_STAT_CONCURRENCY, unversioned.length) },
      () => worker()
    )
  );
}

export async function refreshUnversionedDirectoryKinds(
  workspaceRoot: string,
  statuses: IFileStatus[]
): Promise<void> {
  clearWorkspace(workspaceRoot);
  await updateUnversionedDirectoryKinds(workspaceRoot, statuses);
}
