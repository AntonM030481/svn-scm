import {
  FileSystemProvider,
  workspace,
  Disposable,
  FileStat,
  Uri,
  FileSystemError,
  FileType,
  FileChangeEvent,
  EventEmitter,
  Event,
  window,
  FileChangeType
} from "vscode";
import { SourceControlManager } from "./source_control_manager";
import { fromSvnUri } from "./uri";
import { SvnUriAction, RepositoryChangeEvent } from "./common/types";
import { debounce, throttle } from "./decorators";
import {
  filterEvent,
  eventToPromise,
  isDescendant,
  pathEquals,
  EmptyDisposable
} from "./util";

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

export class SvnFileSystemProvider implements FileSystemProvider, Disposable {
  private disposables: Disposable[] = [];
  private cache = new Map<string, CacheRow>();
  private disposed = false;
  private readonly sourceControlManagerPromise: Promise<SourceControlManager>;

  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private changedRepositoryRoots = new Set<string>();

  constructor(
    sourceControlManager:
      SourceControlManager | PromiseLike<SourceControlManager>
  ) {
    this.sourceControlManagerPromise = Promise.resolve(sourceControlManager);

    // Register the svn: scheme immediately. VS Code can restore virtual SVN
    // documents before repository discovery has finished during activation.
    this.disposables.push(
      workspace.registerFileSystemProvider("svn", this, {
        isReadonly: true,
        isCaseSensitive: true
      })
    );

    void this.sourceControlManagerPromise
      .then(manager => {
        if (this.disposed) {
          return;
        }

        this.disposables.push(
          manager.onDidChangeRepository(this.onDidChangeRepository, this)
        );
      })
      .catch(() => undefined);

    setInterval(() => this.cleanup(), FIVE_MINUTES);
  }

  private async getSourceControlManager(): Promise<SourceControlManager> {
    try {
      const sourceControlManager = await this.sourceControlManagerPromise;
      await sourceControlManager.isInitialized;
      return sourceControlManager;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "SVN initialization failed";
      throw FileSystemError.Unavailable(message);
    }
  }

  private onDidChangeRepository({ repository }: RepositoryChangeEvent): void {
    this.changedRepositoryRoots.add(repository.root);
    this.eventuallyFireChangeEvents();
  }

  @debounce(1100)
  private eventuallyFireChangeEvents(): void {
    this.fireChangeEvents();
  }

  @throttle
  private async fireChangeEvents(): Promise<void> {
    if (!window.state.focused) {
      const onDidFocusWindow = filterEvent(
        window.onDidChangeWindowState,
        e => e.focused
      );
      await eventToPromise(onDidFocusWindow);
    }

    const events: FileChangeEvent[] = [];

    for (const { uri } of this.cache.values()) {
      const fsPath = uri.fsPath;

      for (const root of this.changedRepositoryRoots) {
        if (isDescendant(root, fsPath)) {
          events.push({ type: FileChangeType.Changed, uri });
          break;
        }
      }
    }

    if (events.length > 0) {
      this._onDidChangeFile.fire(events);
    }

    this.changedRepositoryRoots.clear();
  }

  watch(): Disposable {
    return EmptyDisposable;
  }

  async stat(uri: Uri): Promise<FileStat> {
    const sourceControlManager = await this.getSourceControlManager();

    const { fsPath } = fromSvnUri(uri);

    const repository = sourceControlManager.getRepository(fsPath);

    if (!repository) {
      throw FileSystemError.FileNotFound;
    }

    // Avoid `svn list` here. VS Code may call stat() multiple times when
    // opening a diff, and `svn list` can be very slow on large working copies.
    //
    // The virtual SVN document does not require an accurate size/mtime for
    // diff rendering. If metadata becomes necessary, prefer a cheaper local
    // source (for example `svn info`) or cache the result instead of calling
    // `svn list` on every stat().

    return { type: FileType.File, size: 0, mtime: 0, ctime: 0 };
  }

  readDirectory(): Thenable<[string, FileType][]> {
    throw new Error("readDirectory is not implemented");
  }

  createDirectory(): void {
    throw new Error("createDirectory is not implemented");
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const sourceControlManager = await this.getSourceControlManager();

    const { fsPath, extra, action } = fromSvnUri(uri);

    const repository = sourceControlManager.getRepository(fsPath);

    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    const cacheKey = uri.toString();
    const timestamp = new Date().getTime();
    const cacheValue: CacheRow = { uri: uri, timestamp };

    this.cache.set(cacheKey, cacheValue);

    try {
      if (action === SvnUriAction.SHOW) {
        return await repository.showBuffer(fsPath, extra.ref);
      }
      if (action === SvnUriAction.LOG) {
        return await repository.plainLogBuffer();
      }
      if (action === SvnUriAction.LOG_REVISION && extra.revision) {
        return await repository.plainLogByRevisionBuffer(extra.revision);
      }
      if (action === SvnUriAction.LOG_SEARCH && extra.search) {
        return await repository.plainLogByTextBuffer(extra.search);
      }
      if (action === SvnUriAction.PATCH) {
        console.log("here");
        return await repository.patchBuffer([fsPath]);
      }
    } catch {}

    return new Uint8Array(0);
  }

  writeFile(): void {
    throw new Error("writeFile is not implemented");
  }

  delete(): void {
    throw new Error("delete is not implemented");
  }

  rename(): void {
    throw new Error("rename is not implemented");
  }

  private cleanup(): void {
    const now = new Date().getTime();
    const cache = new Map<string, CacheRow>();

    for (const row of this.cache.values()) {
      const { fsPath } = fromSvnUri(row.uri);
      const isOpen = workspace.textDocuments
        .filter(d => d.uri.scheme === "file")
        .some(d => pathEquals(d.uri.fsPath, fsPath));

      if (isOpen || now - row.timestamp < THREE_MINUTES) {
        cache.set(row.uri.toString(), row);
      } else {
        // TODO: should fire delete events?
      }
    }

    this.cache = cache;
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach(d => d.dispose());
  }
}
