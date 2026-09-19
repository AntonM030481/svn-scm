import * as path from "path";
import {
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri,
  window
} from "vscode";
import { Status } from "../common/types";
import { refreshStatusTargets } from "../incrementalStatus";
import { exists, lstat, unlink } from "../fs";
import { Resource } from "../resource";
import { getDisplayErrorMessage } from "../svnError";
import { isUnversionedChildResource } from "../unversionedDirectoryContents";
import { deleteDirectory } from "../util";
import { Command } from "./command";
import { workingCopyScopes } from "./workingCopyScopes";

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resourceFromScmArgument(value: unknown): Resource | undefined {
  if (value instanceof Resource) return value;
  if (!value || typeof value !== "object") return undefined;

  const element = (value as { element?: unknown }).element;
  return element instanceof Resource ? element : undefined;
}

function resourceFolderFromScmArgument(
  value: unknown
): { uri: Uri; group: SourceControlResourceGroup } | undefined {
  if (!value || typeof value !== "object") return undefined;

  const uri = (value as { uri?: unknown }).uri;
  const context = (value as { context?: unknown }).context;
  if (!(uri instanceof Uri) || !context || typeof context !== "object") {
    return undefined;
  }

  const group = context as SourceControlResourceGroup;
  if (!Array.isArray(group.resourceStates)) return undefined;
  return { uri, group };
}

function resourceGroupFromScmArgument(
  value: unknown
): SourceControlResourceGroup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const resourceStates = (value as { resourceStates?: unknown }).resourceStates;
  if (!Array.isArray(resourceStates)) return undefined;
  return value as SourceControlResourceGroup;
}

function topLevelUris(uris: Uri[]): Uri[] {
  const sorted = [...new Map(uris.map(uri => [uri.fsPath, uri])).values()].sort(
    (left, right) => left.fsPath.length - right.fsPath.length
  );
  const result: Uri[] = [];
  for (const uri of sorted) {
    if (!result.some(parent => isPathInside(parent.fsPath, uri.fsPath))) {
      result.push(uri);
    }
  }
  return result;
}

export class DeleteUnversioned extends Command {
  constructor() {
    super("svn.deleteUnversioned");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const resources: Resource[] = [];
    const folders: Uri[] = [];
    for (const value of resourceStates as unknown[]) {
      const resource = resourceFromScmArgument(value);
      if (resource) {
        resources.push(resource);
        continue;
      }

      const folder = resourceFolderFromScmArgument(value);
      if (folder) {
        folders.push(folder.uri);
        continue;
      }

      const group = resourceGroupFromScmArgument(value);
      if (group) {
        resources.push(
          ...(group.resourceStates.filter(
            item => item instanceof Resource
          ) as Resource[])
        );
      }
    }

    const selection = resourceStates.length
      ? resources.length
        ? await this.getResourceStates(resources, true)
        : []
      : await this.getResourceStates([], true);
    const validatedFolders = (
      await this.runByRepository(folders, async (repository, candidates) => {
        await repository.ensureStatus();
        const roots = repository.unversioned.resourceStates.filter(
          resource =>
            resource.type === Status.UNVERSIONED &&
            !isUnversionedChildResource(resource as Resource)
        );
        const result: Uri[] = [];
        for (const candidate of candidates) {
          const containingRoot = roots.find(root =>
            isPathInside(root.resourceUri.fsPath, candidate.fsPath)
          );
          if (!containingRoot) {
            result.push(
              ...roots
                .filter(root =>
                  isPathInside(candidate.fsPath, root.resourceUri.fsPath)
                )
                .map(root => root.resourceUri)
            );
            continue;
          }
          try {
            if ((await lstat(candidate.fsPath)).isDirectory()) {
              result.push(candidate);
            }
          } catch {
            // The selected folder no longer exists.
          }
        }
        return result;
      })
    ).flat();
    const validatedFolderKeys = new Set(
      validatedFolders.map(uri => uri.toString())
    );
    const selectedUris = topLevelUris([
      ...selection.map(resource => resource.resourceUri),
      ...validatedFolders
    ]);
    if (selectedUris.length === 0) {
      return;
    }
    const groups = await this.runByRepository(
      selectedUris,
      async (repository, resources) => {
        await repository.ensureStatus();
        return resources.filter(
          uri =>
            validatedFolderKeys.has(uri.toString()) ||
            repository.getResourceFromFile(uri)?.type === Status.UNVERSIONED
        );
      }
    );
    const uris = groups.flat();
    if (!uris.length) return;
    const answer = await window.showWarningMessage(
      "Would you like to delete selected files?",
      { modal: true },
      "Yes",
      "No"
    );
    if (answer === "Yes") {
      const failures = (
        await this.runByRepository(uris, async (repository, resources) => {
          const deleted: string[] = [];
          const failed: Array<{ path: string; error: unknown }> = [];

          for (const uri of resources) {
            const fsPath = uri.fsPath;

            try {
              if (!(await exists(fsPath))) {
                deleted.push(fsPath);
                continue;
              }

              const stat = await lstat(fsPath);

              if (stat.isDirectory()) {
                await deleteDirectory(fsPath);
              } else {
                await unlink(fsPath);
              }
              deleted.push(fsPath);
            } catch (error) {
              failed.push({ path: fsPath, error });
            }
          }

          if (deleted.length) {
            const scopes = await workingCopyScopes(repository);
            await Promise.all(
              scopes.map(scope => {
                const targets = deleted.filter(filePath =>
                  isPathInside(scope.workspaceRoot, filePath)
                );
                return targets.length
                  ? refreshStatusTargets(scope, targets)
                  : Promise.resolve();
              })
            );
          }

          return failed;
        })
      ).flat();

      if (failures.length) {
        const first = failures[0];
        const suffix =
          failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
        window.showErrorMessage(
          `Unable to delete "${path.basename(first.path)}": ${getDisplayErrorMessage(
            first.error
          )}${suffix}`
        );
      }
    }
  }
}
