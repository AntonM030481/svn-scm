import * as path from "path";
import { IFileStatus, Status } from "./common/types";
import { lstat } from "./fs";

const directoryPaths = new Set<string>();
const MAX_STAT_CONCURRENCY = 16;

function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

export async function refreshUnversionedDirectoryKinds(
  workspaceRoot: string,
  statuses: IFileStatus[]
): Promise<void> {
  clearWorkspace(workspaceRoot);

  const unversioned = statuses.filter(
    status => status.status === Status.UNVERSIONED
  );
  let next = 0;

  const worker = async () => {
    while (next < unversioned.length) {
      const status = unversioned[next++];
      const file = path.join(workspaceRoot, status.path);

      try {
        if ((await lstat(file)).isDirectory()) {
          directoryPaths.add(key(file));
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
