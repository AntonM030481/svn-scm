import * as path from "path";
import {
  commands,
  Disposable,
  Position,
  Range,
  SourceControlResourceState,
  TextDocumentShowOptions,
  TextEditor,
  Uri,
  ViewColumn,
  window,
  workspace,
  WorkspaceEdit
} from "vscode";
import {
  ICommandOptions,
  Status,
  SvnUriAction,
  LineChange
} from "../common/types";
import { exists, readFile, stat, unlink } from "../fs";
import { hasCompleteConflictMarkers } from "../conflictMarkers";
import { inputIgnoreList } from "../ignoreitems";
import { applyLineChanges } from "../lineChanges";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import { Resource } from "../resource";
import IncomingChangeNode from "../treeView/nodes/incomingChangeNode";
import { fromSvnUri, toSvnUri } from "../uri";
import { getSvnDir } from "../util";

export abstract class Command implements Disposable {
  private _disposable?: Disposable;

  constructor(commandName: string, options: ICommandOptions = {}) {
    const command = options.repository
      ? this.createRepositoryCommand(this.execute)
      : (...args: any[]) => this.execute(...args);
    this._disposable = commands.registerCommand(commandName, command);
  }

  public abstract execute(...args: any[]): any;

  public dispose() {
    this._disposable?.dispose();
  }

  private createRepositoryCommand(
    method: (...args: any[]) => void
  ): (...args: any[]) => any {
    return async (...args: any[]) => {
      try {
        const sourceControlManager = (await commands.executeCommand(
          "svn.getSourceControlManager",
          ""
        )) as SourceControlManager;
        const repository =
          sourceControlManager.getRepository(args[0]) ||
          (sourceControlManager.repositories.length === 1
            ? sourceControlManager.repositories[0]
            : await sourceControlManager.pickRepository());

        if (!repository) {
          return;
        }

        return await method.apply(this, [repository, ...args]);
      } catch (err) {
        console.error(err);
      }
    };
  }

  protected async getResourceStates(
    resourceStates: SourceControlResourceState[],
    validateForMutation = false
  ): Promise<Resource[]> {
    if (
      resourceStates.length === 0 ||
      !(resourceStates[0].resourceUri instanceof Uri)
    ) {
      const resource = await this.getSCMResource();

      if (!resource) {
        return [];
      }

      resourceStates = [resource];
    }

    const selection = resourceStates.filter(
      s => s instanceof Resource
    ) as Resource[];
    if (!validateForMutation || !selection.length) return selection;
    const selected = new Map(
      selection.map(resource => [resource.resourceUri.toString(), resource])
    );
    const groups = await this.runByRepository(
      selection.map(resource => resource.resourceUri),
      async (repository, uris) => {
        await repository.ensureStatus();
        const current: Resource[] = [];
        for (const uri of uris) {
          const before = selected.get(uri.toString())!;
          // A saved directory selection does not authorize newly discovered descendants.
          // Require reselection from the live model, even if its own properties match.
          if (repository.isPreviewResource(before)) {
            try {
              if (!(await stat(uri.fsPath)).isFile()) continue;
            } catch {
              continue;
            }
          }
          const after = before.remote
            ? repository.remoteChanges?.resourceStates.find(
                resource => resource.resourceUri.toString() === uri.toString()
              )
            : repository.getResourceFromFile(uri);
          // Do not silently reinterpret an old selection as a different operation target.
          if (
            after &&
            after.type === before.type &&
            after.props === before.props &&
            after.renameResourceUri?.toString() ===
              before.renameResourceUri?.toString()
          ) {
            current.push(after);
          }
        }
        return current;
      }
    );
    return groups.flat();
  }

  protected runByRepository<T>(
    resource: Uri,
    fn: (repository: Repository, resource: Uri) => Promise<T>
  ): Promise<T[]>;
  protected runByRepository<T>(
    resources: Uri[],
    fn: (repository: Repository, resources: Uri[]) => Promise<T>
  ): Promise<T[]>;
  protected async runByRepository<T>(
    arg: Uri | Uri[],
    fn: (repository: Repository, resources: any) => Promise<T>
  ): Promise<T[]> {
    const resources = arg instanceof Uri ? [arg] : arg;
    const isSingleResource = arg instanceof Uri;

    const sourceControlManager = (await commands.executeCommand(
      "svn.getSourceControlManager",
      ""
    )) as SourceControlManager;

    const groups = new Map<Repository, Uri[]>();

    for (const resource of resources) {
      const repository = sourceControlManager.getRepository(resource);

      if (!repository) {
        console.warn("Could not find Svn repository for ", resource);
        continue;
      }

      const repositoryResources = groups.get(repository);
      if (repositoryResources) repositoryResources.push(resource);
      else groups.set(repository, [resource]);
    }

    const promises = Array.from(groups, ([repository, resources]) =>
      fn(repository, isSingleResource ? resources[0] : resources)
    );

    return Promise.all(promises);
  }

  protected async getSCMResource(uri?: Uri): Promise<Resource | undefined> {
    uri = uri
      ? uri
      : window.activeTextEditor && window.activeTextEditor.document.uri;

    if (!uri) {
      return undefined;
    }

    if (uri.scheme === "svn") {
      const { fsPath } = fromSvnUri(uri);
      uri = Uri.file(fsPath);
    }

    if (uri.scheme === "file") {
      const sourceControlManager = (await commands.executeCommand(
        "svn.getSourceControlManager",
        ""
      )) as SourceControlManager;
      const repository = sourceControlManager.getRepository(uri);

      if (!repository) {
        return undefined;
      }

      return repository.getResourceFromFile(uri);
    }

    return;
  }

  protected async _openResource(
    resource: Resource,
    against?: string,
    preview?: boolean,
    preserveFocus?: boolean,
    preserveSelection?: boolean
  ): Promise<void> {
    let left = await this.getLeftResource(resource, against);
    let right = this.getRightResource(resource, against);
    const title = this.getTitle(resource, against);

    if (resource.remote && left) {
      [left, right] = [right, left];
    }

    if (!right) {
      // TODO
      console.error("oh no");
      return;
    }

    if (
      (await exists(right.fsPath)) &&
      (await stat(right.fsPath)).isDirectory()
    ) {
      return;
    }

    const opts: TextDocumentShowOptions = {
      preserveFocus,
      preview,
      viewColumn: ViewColumn.Active
    };

    const activeTextEditor = window.activeTextEditor;

    if (
      preserveSelection &&
      activeTextEditor &&
      activeTextEditor.document.uri.toString() === right.toString()
    ) {
      opts.selection = activeTextEditor.selection;
    }

    if (!left) {
      return commands.executeCommand<void>("vscode.open", right, opts);
    }

    return commands.executeCommand<void>(
      "vscode.diff",
      left,
      right,
      title,
      opts
    );
  }

  protected async getLeftResource(
    resource: Resource,
    against: string = ""
  ): Promise<Uri | undefined> {
    if (resource.remote) {
      if (resource.type !== Status.DELETED) {
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
      }
      return;
    }

    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      return toSvnUri(resource.renameResourceUri, SvnUriAction.SHOW, {
        ref: against
      });
    }

    // Show file if has conflicts marks
    if (
      resource.type === Status.CONFLICTED &&
      (await exists(resource.resourceUri.fsPath))
    ) {
      const text = (await readFile(resource.resourceUri.fsPath, {
        encoding: "utf8"
      })) as string;

      if (hasCompleteConflictMarkers(text)) {
        return undefined;
      }
    }

    switch (resource.type) {
      case Status.CONFLICTED:
      case Status.MODIFIED:
      case Status.REPLACED:
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
    }

    return;
  }

  protected getRightResource(
    resource: Resource,
    against: string = ""
  ): Uri | undefined {
    if (resource.remote) {
      if (resource.type !== Status.ADDED) {
        return resource.resourceUri;
      }
      return;
    }
    switch (resource.type) {
      case Status.ADDED:
      case Status.CONFLICTED:
      case Status.IGNORED:
      case Status.MODIFIED:
      case Status.UNVERSIONED:
      case Status.REPLACED:
        return resource.resourceUri;
      case Status.DELETED:
      case Status.MISSING:
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
    }

    return;
  }

  private getTitle(resource: Resource, against?: string): string {
    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      const basename = path.basename(resource.renameResourceUri.fsPath);

      const newname = path.relative(
        path.dirname(resource.renameResourceUri.fsPath),
        resource.resourceUri.fsPath
      );
      if (against) {
        return `${basename} -> ${newname} (${against})`;
      }
      return `${basename} -> ${newname}`;
    }
    const basename = path.basename(resource.resourceUri.fsPath);

    if (against) {
      return `${basename} (${against})`;
    }

    return "";
  }

  protected async openChange(
    arg?: Resource | Uri | IncomingChangeNode,
    against?: string,
    resourceStates?: SourceControlResourceState[]
  ): Promise<void> {
    const preserveFocus = arg instanceof Resource;
    const preserveSelection = arg instanceof Uri || !arg;
    let resources: Resource[] | undefined;

    if (arg instanceof Uri) {
      const resource = await this.getSCMResource(arg);
      if (resource !== undefined) {
        resources = [resource];
      }
    } else if (arg instanceof IncomingChangeNode) {
      const resource = new Resource(
        arg.uri,
        arg.type,
        undefined,
        arg.props,
        true
      );

      resources = [resource];
    } else {
      let resource: Resource | undefined;

      if (arg instanceof Resource) {
        resource = arg;
      } else {
        resource = await this.getSCMResource();
      }

      if (resource) {
        resources = [...(resourceStates as Resource[]), resource];
      }
    }

    if (!resources) {
      return;
    }

    const preview = resources.length === 1 ? undefined : false;
    for (const resource of resources) {
      await this._openResource(
        resource,
        against,
        preview,
        preserveFocus,
        preserveSelection
      );
    }
  }

  protected async showDiffPath(repository: Repository, content: string) {
    try {
      const tempFile = path.join(
        repository.root,
        getSvnDir(),
        "tmp",
        "svn.patch"
      );

      if (await exists(tempFile)) {
        try {
          await unlink(tempFile);
        } catch (_error) {
          // TODO(cjohnston)//log error
        }
      }

      const uri = Uri.file(tempFile).with({
        scheme: "untitled"
      });

      const document = await workspace.openTextDocument(uri);
      const textEditor = await window.showTextDocument(document);

      await textEditor.edit(e => {
        // if is opened, clear content
        e.delete(
          new Range(
            new Position(0, 0),
            new Position(Number.MAX_SAFE_INTEGER, 0)
          )
        );
        e.insert(new Position(0, 0), content);
      });
    } catch (error) {
      console.error(error);
      window.showErrorMessage("Unable to patch");
    }
  }

  protected async _revertChanges(
    textEditor: TextEditor,
    changes: LineChange[]
  ): Promise<void> {
    const modifiedDocument = textEditor.document;
    const modifiedUri = modifiedDocument.uri;

    if (modifiedUri.scheme !== "file") {
      return;
    }

    const originalUri = toSvnUri(modifiedUri, SvnUriAction.SHOW, {
      ref: "BASE"
    });
    const originalDocument = await workspace.openTextDocument(originalUri);

    const result = applyLineChanges(
      originalDocument,
      modifiedDocument,
      changes
    );
    const edit = new WorkspaceEdit();
    edit.replace(
      modifiedUri,
      new Range(
        new Position(0, 0),
        modifiedDocument.lineAt(modifiedDocument.lineCount - 1).range.end
      ),
      result
    );
    workspace.applyEdit(edit);
    await modifiedDocument.save();
  }

  protected async addToIgnore(uris: Uri[]): Promise<void> {
    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      try {
        const ignored = await inputIgnoreList(repository, resources);

        if (ignored) {
          window.showInformationMessage(`File(s) is now being ignored`);
        }
      } catch (error) {
        console.log(error);
        window.showErrorMessage("Unable to set property ignore");
      }
    });
  }
}
