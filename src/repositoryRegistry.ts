import * as path from "path";
import { Uri } from "vscode";
import { IOpenRepository } from "./common/types";
import { Repository } from "./repository";
import { isDescendant } from "./util";

export class RepositoryRegistry {
  private entries: IOpenRepository[] = [];
  private sortedEntries?: IOpenRepository[];
  private sortedSource?: IOpenRepository[];

  public get openRepositories(): IOpenRepository[] {
    return this.entries;
  }

  public set openRepositories(entries: IOpenRepository[]) {
    this.entries = entries;
    this.invalidate();
  }

  public get repositories(): Repository[] {
    return this.entries.map(entry => entry.repository);
  }

  public add(entry: IOpenRepository): void {
    this.entries.push(entry);
    this.invalidate();
  }

  public remove(entry: IOpenRepository): void {
    this.entries = this.entries.filter(candidate => candidate !== entry);
    this.invalidate();
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

  public resolveHint(hint: any): IOpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.entries.find(entry => entry.repository === hint);
    }

    if ((hint as any).repository instanceof Repository) {
      return this.entries.find(
        entry => entry.repository === (hint as any).repository
      );
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
    const { repository } = entry;
    return [...repository.statusExternal, ...repository.statusIgnored].some(
      status =>
        isDescendant(path.join(repository.workspaceRoot, status.path), filePath)
    );
  }

  private invalidate(): void {
    this.sortedEntries = undefined;
    this.sortedSource = undefined;
  }
}
