import * as path from "path";
import { promises as fs } from "node:fs";
import { Disposable, Uri, workspace } from "vscode";
import { Status } from "./common/types";
import { configuration } from "./helpers/configuration";
import { Repository } from "./repository";
import { Resource } from "./resource";
import { SourceControlManager } from "./source_control_manager";
import { dispose, getSvnDir } from "./util";
import { matchAll } from "./util/globMatch";

const MAX_UNVERSIONED_CHILDREN = 2000;

interface RepositoryState {
  generation: number;
  disposables: Disposable[];
}

export class UnversionedChildResource extends Resource {
  constructor(resourceUri: Uri, public readonly unversionedRoot: string) {
    super(resourceUri, Status.UNVERSIONED);
  }
}

export function isUnversionedChildResource(
  resource: Resource
): resource is UnversionedChildResource {
  return resource instanceof UnversionedChildResource;
}

function excludePatterns(repository: Repository): string[] {
  const files = workspace.getConfiguration("files", Uri.file(repository.root));
  const excluded = files.get<Record<string, boolean>>("exclude", {});
  return Object.entries(excluded).map(([pattern, enabled]) =>
    enabled ? pattern : `!${pattern}`
  );
}

function shouldInclude(
  relativePath: string,
  excludeList: string[],
  ignoreList: string[]
): boolean {
  if (matchAll(relativePath, excludeList, { dot: true })) return false;
  if (
    ignoreList.length &&
    matchAll(path.sep + relativePath, ignoreList, {
      dot: true,
      matchBase: true
    })
  ) {
    return false;
  }
  return true;
}

async function collectFiles(
  repository: Repository,
  root: string,
  budget: { remaining: number }
): Promise<UnversionedChildResource[]> {
  const result: UnversionedChildResource[] = [];
  const queue = [root];
  const excludeList = excludePatterns(repository);
  const ignoreList = configuration.get<string[]>("sourceControl.ignore");

  while (queue.length && budget.remaining > 0) {
    const directory = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (budget.remaining <= 0) break;
      if (entry.name === getSvnDir()) continue;

      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repository.workspaceRoot, absolute);
      if (!shouldInclude(relative, excludeList, ignoreList)) continue;

      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      result.push(new UnversionedChildResource(Uri.file(absolute), root));
      budget.remaining -= 1;
    }
  }

  return result;
}

export class UnversionedDirectoryContents implements Disposable {
  private readonly states = new Map<Repository, RepositoryState>();
  private readonly disposables: Disposable[] = [];

  constructor(private readonly sourceControlManager: SourceControlManager) {
    sourceControlManager.repositories.forEach(repository =>
      this.attach(repository)
    );
    this.disposables.push(
      sourceControlManager.onDidOpenRepository(repository =>
        this.attach(repository)
      ),
      sourceControlManager.onDidCloseRepository(repository =>
        this.detach(repository)
      )
    );
  }

  dispose(): void {
    for (const repository of [...this.states.keys()]) this.detach(repository);
    dispose(this.disposables);
  }

  private attach(repository: Repository): void {
    if (this.states.has(repository)) return;
    const state: RepositoryState = { generation: 0, disposables: [] };
    this.states.set(repository, state);
    state.disposables.push(
      repository.onDidRebuildStatusProjection(() => {
        void this.refresh(repository);
      })
    );
    void this.refresh(repository);
  }

  private detach(repository: Repository): void {
    const state = this.states.get(repository);
    if (!state) return;
    state.generation += 1;
    dispose(state.disposables);
    this.states.delete(repository);
  }

  private async refresh(repository: Repository): Promise<void> {
    const state = this.states.get(repository);
    if (!state) return;
    const generation = ++state.generation;

    const baseResources = repository.unversioned.resourceStates.filter(
      resource => !(resource instanceof UnversionedChildResource)
    ) as Resource[];
    const budget = { remaining: MAX_UNVERSIONED_CHILDREN };
    const children: UnversionedChildResource[] = [];

    for (const resource of baseResources) {
      if (
        resource.type !== Status.UNVERSIONED ||
        budget.remaining <= 0
      ) {
        continue;
      }
      try {
        const stat = await fs.lstat(resource.resourceUri.fsPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      children.push(
        ...(await collectFiles(
          repository,
          resource.resourceUri.fsPath,
          budget
        ))
      );
    }

    if (
      this.states.get(repository) !== state ||
      generation !== state.generation
    ) {
      return;
    }

    if (budget.remaining === 0) {
      console.warn(
        `Unversioned directory contents capped at ${MAX_UNVERSIONED_CHILDREN} files for ${repository.workspaceRoot}`
      );
    }

    const byUri = new Map<string, Resource>();
    [...baseResources, ...children].forEach(resource =>
      byUri.set(resource.resourceUri.toString(), resource)
    );
    repository.unversioned.resourceStates = [...byUri.values()];
  }
}
