import { Event, Uri, workspace, EventEmitter, RelativePattern } from "vscode";
import { FSWatcher, watch } from "node:fs";
import { physicalFs } from "../fs/physical";
import { exists } from "../fs";
import { isAbsolute, join, normalize, resolve } from "path";
import { cancelDebounces, debounce } from "../decorators";
import {
  anyEvent,
  filterEvent,
  IDisposable,
  isDescendant,
  fixPathSeparator,
  getSvnDir
} from "../util";

export function isWorkspaceFileChange(uri: Uri): boolean {
  try {
    return !physicalFs.statSync(uri.fsPath).isDirectory();
  } catch {
    // The path can disappear between the change event and this check. Keep the
    // event in that case so status can remove stale state if necessary.
    return true;
  }
}

export function resolveNativeWatcherPath(
  metadataRoot: string,
  filename: string | Buffer | null
): string | undefined {
  if (filename === null) {
    return undefined;
  }

  const value = Buffer.isBuffer(filename) ? filename.toString() : filename;
  return normalize(isAbsolute(value) ? value : resolve(metadataRoot, value));
}

type NativeWatchFactory = (
  path: string,
  listener: (event: string, filename: string | Buffer | null) => void
) => FSWatcher;

export class RepositoryFilesWatcher implements IDisposable {
  private disposables: IDisposable[] = [];
  private nativeWatcher?: FSWatcher;
  private nativeMetadataRoot?: string;
  private disposed = false;

  private _onRepoChange: EventEmitter<Uri>;
  private _onRepoCreate: EventEmitter<Uri>;
  private _onRepoDelete: EventEmitter<Uri>;

  public onDidChange: Event<Uri>;
  public onDidCreate: Event<Uri>;
  public onDidDelete: Event<Uri>;
  public onDidAny: Event<Uri>;

  public onDidWorkspaceChange: Event<Uri>;
  public onDidWorkspaceCreate: Event<Uri>;
  public onDidWorkspaceDelete: Event<Uri>;
  public onDidWorkspaceAny: Event<Uri>;

  public onDidSvnChange: Event<Uri>;
  public onDidSvnCreate: Event<Uri>;
  public onDidSvnDelete: Event<Uri>;
  public onDidSvnAny: Event<Uri>;

  constructor(
    readonly root: string,
    nativeWatch: NativeWatchFactory = watch as NativeWatchFactory
  ) {
    const fsWatcher = workspace.createFileSystemWatcher(
      new RelativePattern(fixPathSeparator(root), "**")
    );
    this._onRepoChange = new EventEmitter<Uri>();
    this._onRepoCreate = new EventEmitter<Uri>();
    this._onRepoDelete = new EventEmitter<Uri>();
    let onRepoChange: Event<Uri> | undefined;
    let onRepoCreate: Event<Uri> | undefined;
    let onRepoDelete: Event<Uri> | undefined;

    if (
      !workspace.workspaceFolders?.some(w => isDescendant(w.uri.fsPath, root))
    ) {
      this.nativeMetadataRoot = join(root, getSvnDir());
      this.nativeWatcher = nativeWatch(
        this.nativeMetadataRoot,
        this.repoWatch.bind(this)
      );

      this.nativeWatcher.on("error", error => {
        if (!this.disposed) {
          console.error(`SVN metadata watcher failed for "${root}"`, error);
        }
      });

      onRepoChange = this._onRepoChange.event;
      onRepoCreate = this._onRepoCreate.event;
      onRepoDelete = this._onRepoDelete.event;
    }

    this.disposables.push(fsWatcher);

    // Ignore changes emitted by our own virtual SVN filesystem. Quick Diff uses
    // svn: URIs whose paths intentionally end in ".svn"; treating those as
    // working-copy files causes bogus status calls such as "file.cpp.svn" and
    // can trigger another refresh cycle after every model update.
    const isInternalVirtualFs = (uri: Uri) =>
      uri.scheme === "svn" || uri.scheme === "tempsvnfs";

    //https://subversion.apache.org/docs/release-notes/1.3.html#_svn-hack
    const isTmp = (uri: Uri) => /[\\\/](\.svn|_svn)[\\\/]tmp/.test(uri.path);

    const isRelevant = (uri: Uri) => !isInternalVirtualFs(uri) && !isTmp(uri);
    const isRelevantChange = (uri: Uri) =>
      isRelevant(uri) && isWorkspaceFileChange(uri);

    this.onDidChange = filterEvent(fsWatcher.onDidChange, isRelevantChange);
    this.onDidCreate = filterEvent(fsWatcher.onDidCreate, isRelevant);
    this.onDidDelete = filterEvent(fsWatcher.onDidDelete, isRelevant);

    this.onDidAny = anyEvent(
      this.onDidChange,
      this.onDidCreate,
      this.onDidDelete
    );

    //https://subversion.apache.org/docs/release-notes/1.3.html#_svn-hack
    const svnPattern = /[\\\/](\.svn|_svn)[\\\/]/;

    const ignoreSvn = (uri: Uri) => !svnPattern.test(uri.path);

    this.onDidWorkspaceChange = filterEvent(this.onDidChange, ignoreSvn);
    this.onDidWorkspaceCreate = filterEvent(this.onDidCreate, ignoreSvn);
    this.onDidWorkspaceDelete = filterEvent(this.onDidDelete, ignoreSvn);

    this.onDidWorkspaceAny = anyEvent(
      this.onDidWorkspaceChange,
      this.onDidWorkspaceCreate,
      this.onDidWorkspaceDelete
    );
    const ignoreWorkspace = (uri: Uri) => svnPattern.test(uri.path);

    this.onDidSvnChange = filterEvent(this.onDidChange, ignoreWorkspace);
    this.onDidSvnCreate = filterEvent(this.onDidCreate, ignoreWorkspace);
    this.onDidSvnDelete = filterEvent(this.onDidDelete, ignoreWorkspace);

    if (onRepoChange && onRepoCreate && onRepoDelete) {
      this.onDidSvnChange = onRepoChange;
      this.onDidSvnCreate = onRepoCreate;
      this.onDidSvnDelete = onRepoDelete;
    }

    this.onDidSvnAny = anyEvent(
      this.onDidSvnChange,
      this.onDidSvnCreate,
      this.onDidSvnDelete
    );
  }

  @debounce(1000)
  private repoWatch(event: string, filename: string | Buffer | null): void {
    if (this.disposed || this.nativeMetadataRoot === undefined) {
      return;
    }

    const filePath = resolveNativeWatcherPath(
      this.nativeMetadataRoot,
      filename
    );
    if (filePath === undefined) {
      return;
    }

    const uri = Uri.file(filePath);

    if (event === "change") {
      this._onRepoChange.fire(uri);
    } else if (event === "rename") {
      exists(filePath).then(doesExist => {
        if (this.disposed) {
          return;
        }
        if (doesExist) {
          this._onRepoCreate.fire(uri);
        } else {
          this._onRepoDelete.fire(uri);
        }
      });
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.nativeWatcher?.close();
    this.nativeWatcher = undefined;
    cancelDebounces(this);
    this.disposables.forEach(d => d.dispose());
  }
}
