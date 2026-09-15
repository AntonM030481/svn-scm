import * as path from "path";
import { commands, window } from "vscode";
import { Operation } from "../common/types";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { SourceControlManager } from "../source_control_manager";
import { isDescendant, normalizePath } from "../util";

export async function workingCopyScopes(
  repository: Repository
): Promise<Repository[]> {
  const manager = (await commands.executeCommand(
    "svn.getSourceControlManager",
    ""
  )) as SourceControlManager;
  return manager
    .repositoriesForWorkingCopy(repository)
    .sort((left, right) =>
      normalizePath(left.workspaceRoot).localeCompare(
        normalizePath(right.workspaceRoot)
      )
    );
}

export async function workingCopyOperationScopes(
  repository: Repository
): Promise<Repository[]> {
  const scopes = await workingCopyScopes(repository);
  return scopes.filter(
    (scope, index) =>
      !scopes.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          candidate.workspaceRoot !== scope.workspaceRoot &&
          isDescendant(candidate.workspaceRoot, scope.workspaceRoot)
      )
  );
}

export async function runWorkingCopyOperation<T>(
  repository: Repository,
  operationType: Operation,
  operation: (scope: Repository) => Promise<T>
): Promise<T[]> {
  const allScopes = await workingCopyScopes(repository);
  const operationScopes = await workingCopyOperationScopes(repository);
  const results: T[] = [];
  try {
    await Promise.all(allScopes.map(scope => scope.ensureStatus()));
    for (const scope of operationScopes) {
      const siblingMarkers = allScopes
        .filter(candidate => candidate !== scope)
        .map(candidate => candidate.markOperation(operationType));
      try {
        results.push(await operation(scope));
      } finally {
        siblingMarkers.reverse().forEach(marker => marker.dispose());
      }
    }
    await Promise.all(
      allScopes
        .filter(scope => !operationScopes.includes(scope))
        .map(scope => scope.status())
    );
  } catch (error) {
    await Promise.allSettled(allScopes.map(scope => scope.status()));
    throw error;
  }
  return results;
}

export function uniqueScopeResources(
  scopes: Repository[],
  select: (scope: Repository) => Resource[]
): Array<{ scope: Repository; resource: Resource }> {
  const resources = new Map<
    string,
    { scope: Repository; resource: Resource }
  >();
  for (const scope of [...scopes].sort(
    (left, right) => right.workspaceRoot.length - left.workspaceRoot.length
  )) {
    for (const resource of select(scope)) {
      const key = normalizePath(resource.resourceUri.fsPath);
      if (!resources.has(key)) resources.set(key, { scope, resource });
    }
  }
  return [...resources.values()];
}

export async function selectWorkingCopyScope(
  repository: Repository,
  placeHolder: string
): Promise<Repository | undefined> {
  const scopes = await workingCopyScopes(repository);
  if (scopes.length <= 1) return scopes[0];
  const pick = await window.showQuickPick(
    scopes.map(scope => ({
      label: path.basename(scope.workspaceRoot),
      description: scope.workspaceRoot,
      scope
    })),
    { placeHolder }
  );
  return pick?.scope;
}
