import * as path from "path";
import { IFileStatus, Status } from "./common/types";
import { lstat } from "./fs";

const MAX_STAT_CONCURRENCY = 16;
const projections = new Set<UnversionedDirectoryProjection>();

export interface UnversionedDirectoryProjection {
  directoryPaths: Set<string>;
  dispose(): void;
}

function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function absolutePath(workspaceRoot: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

export function createUnversionedDirectoryProjection(): UnversionedDirectoryProjection {
  const projection: UnversionedDirectoryProjection = {
    directoryPaths: new Set<string>(),
    dispose: () => {
      projections.delete(projection);
      projection.directoryPaths.clear();
    }
  };
  projections.add(projection);
  return projection;
}

export function isUnversionedDirectory(file: string): boolean {
  const fileKey = key(file);
  for (const projection of projections) {
    if (projection.directoryPaths.has(fileKey)) {
      return true;
    }
  }
  return false;
}

export async function updateUnversionedDirectoryKinds(
  projection: UnversionedDirectoryProjection,
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
      projection.directoryPaths.delete(fileKey);

      try {
        if ((await lstat(file)).isDirectory()) {
          projection.directoryPaths.add(fileKey);
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
  projection: UnversionedDirectoryProjection,
  workspaceRoot: string,
  statuses: IFileStatus[]
): Promise<void> {
  projection.directoryPaths.clear();
  await updateUnversionedDirectoryKinds(projection, workspaceRoot, statuses);
}
