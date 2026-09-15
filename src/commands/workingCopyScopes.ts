import * as path from "path";
import { commands, window } from "vscode";
import { Repository } from "../repository";
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
  operation: (scope: Repository) => Promise<T>
): Promise<T[]> {
  const allScopes = await workingCopyScopes(repository);
  const operationScopes = await workingCopyOperationScopes(repository);
  const results: T[] = [];
  try {
    for (const scope of operationScopes) {
      results.push(await operation(scope));
    }
  } catch (error) {
    await Promise.allSettled(allScopes.map(scope => scope.status()));
    throw error;
  }
  return results;
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
