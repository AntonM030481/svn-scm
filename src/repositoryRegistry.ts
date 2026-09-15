import * as path from "path";
import { Uri } from "vscode";
import { IOpenRepository } from "./common/types";
import { Repository } from "./repository";
import { isDescendant, normalizePath } from "./util";

export class RepositoryRegistry {
  private entries: IOpenRepository[] = [];
  private sortedEntries?: IOpenRepository[];
  private sortedSource?: IOpenRepository[];
  private exclusions = new WeakMap<Repository, Set<string>>();

  public get openRepositories(): IOpenRepository[] {
    return this.entries;
  }

  public set openRepositories(entries: IOpenRepository[]) {
    this.entries = entries;
    this.exclusions = new WeakMap();
    for (const entry of entries) {
      this.refreshExclusions(entry.repository);
    }
    this.invalidate();
  }

  public get repositories(): Repository[] {
    return this.entries.map(entry => entry.repository);
  }

  public add(entry: IOpenRepository): void {
    this.entries.push(entry);
    this.refreshExclusions(entry.repository);
    this.invalidate();
  }

  public remove(entry: IOpenRepository): void {
    this.entries = this.entries.filter(candidate => candidate !== entry);
    this.exclusions.delete(entry.repository);
    this.invalidate();
  }

  public refreshExclusions(repository: Repository): void {
    const roots = new Set(
      [...repository.statusExternal, ...repository.statusIgnored].map(status =>
        normalizePath(path.join(repository.workspaceRoot, status.path))
      )
    );
    this.exclusions.set(repository, roots);
  }

  public deepestFirst(): IOpenRepository[] {
    if (
      !this.sortedEntries ||
      !this.sortedSource ||
      this.sortedSource.length !== this.entries.length ||
      this.sortedSource.some((entry, index) => entry !== this.entries[index])
    ) {
      this.sortedSource = [...this.entries];
      this.sortedEntries = [...this.entries].sort(
        (a, b) =>
          b.repository.workspaceRoot.length - a.repository.workspaceRoot.length
      );
    }

    return this.sortedEntries;
  }

  public resolveHint(hint: unknown): IOpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.entries.find(entry => entry.repository === hint);
    }

    if (
      typeof hint === "object" &&
      hint !== null &&
      "repository" in hint &&
      hint.repository instanceof Repository
    ) {
      const repository = hint.repository;
      return this.entries.find(entry => entry.repository === repository);
    }

    if (typeof hint === "string") {
      hint = Uri.file(hint);
    }

    if (hint instanceof Uri) {
      const owner = this.deepestFirst().find(entry =>
        isDescendant(entry.repository.workspaceRoot, hint.fsPath)
      );
      if (!owner || this.isExcluded(owner, hint.fsPath)) {
        return undefined;
      }

      return owner;
    }

    return this.entries.find(
      entry =>
        hint === entry.repository.sourceControl ||
        hint === entry.repository.changes
    );
  }

  private isExcluded(entry: IOpenRepository, filePath: string): boolean {
    const roots = this.exclusions.get(entry.repository);
    let candidate = normalizePath(filePath);
    while (true) {
      if (roots?.has(candidate)) {
        return true;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return false;
      }
      candidate = parent;
    }
  }

  private invalidate(): void {
    this.sortedEntries = undefined;
    this.sortedSource = undefined;
  }
}
