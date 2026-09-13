import type { Stats } from "node:fs";
import * as path from "path";
import * as semver from "semver";
import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  Uri,
  window,
  workspace,
  WorkspaceFoldersChangeEvent
} from "vscode";
import {
  ConstructorPolicy,
  RepositoryChangeEvent,
  IOpenRepository,
  RepositoryState,
  Status
} from "./common/types";
import { cancelDebounces, debounce } from "./decorators";
import { readdir, stat } from "./fs";
import { configuration } from "./helpers/configuration";
import { RemoteRepository } from "./remoteRepository";
import { Repository } from "./repository";
import { Svn, svnErrorCodes } from "./svn";
import SvnError from "./svnError";
import {
  anyEvent,
  dispose,
  filterEvent,
  IDisposable,
  isDescendant,
  getSvnDir,
  isSvnFolder,
  normalizePath,
  eventToPromise
} from "./util";
import { matchAll } from "./util/globMatch";

type State = "uninitialized" | "initialized";

interface DiscoveryOptions {
  allowNested?: boolean;
  recursive?: boolean;
  lifecycleGeneration?: number;
}

export function getSvnRepositoryPathFromMetadata(
  filePath: string,
  svnDir: string = getSvnDir()
): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const comparable = normalized.toLowerCase();
  const marker = `/${svnDir.toLowerCase()}/`;
  const markerIndex = comparable.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return filePath.slice(0, markerIndex);
  }

  const directoryMarker = `/${svnDir.toLowerCase()}`;
  if (comparable.endsWith(directoryMarker)) {
    return filePath.slice(0, comparable.length - directoryMarker.length);
  }

  return undefined;
}

export function isSvnMetadataLookalikeDirectory(filePath: string): boolean {
  return /^(\.svn|_svn)[.-]/i.test(path.basename(filePath.replace(/\\/g, "/")));
}

export class SourceControlManager implements IDisposable {
  private _onDidOpenRepository = new EventEmitter<Repository>();
  public readonly onDidOpenRepository: Event<Repository> =
    this._onDidOpenRepository.event;

  private _onDidCloseRepository = new EventEmitter<Repository>();
  public readonly onDidCloseRepository: Event<Repository> =
    this._onDidCloseRepository.event;

  private _onDidChangeRepository = new EventEmitter<RepositoryChangeEvent>();
  public readonly onDidChangeRepository: Event<RepositoryChangeEvent> =
    this._onDidChangeRepository.event;

  private _onDidChangeStatusRepository = new EventEmitter<Repository>();
  public readonly onDidChangeStatusRepository: Event<Repository> =
    this._onDidChangeStatusRepository.event;

  public openRepositories: IOpenRepository[] = [];
  private disposables: Disposable[] = [];
  private enabled = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private routingValidations = new WeakMap<
    Repository,
    Map<string, Promise<boolean>>
  >();
  private possibleSvnRepositoryPaths = new Map<string, boolean>();
  private provisionalLegacyRepositories = new WeakSet<Repository>();
  private ignoreList: string[] = [];
  private maxDepth: number = 0;

  private configurationChangeDisposable: Disposable;

  private _onDidChangeState = new EventEmitter<State>();
  readonly onDidchangeState = this._onDidChangeState.event;

  private _state: State = "uninitialized";
  get state(): State {
    return this._state;
  }

  setState(state: State): void {
    this._state = state;
    this._onDidChangeState.fire(state);
  }

  get isInitialized(): Promise<void> {
    if (this._state === "initialized") {
      return Promise.resolve();
    }

    return eventToPromise(
      filterEvent(this.onDidchangeState, s => s === "initialized")
    ) as Promise<any>;
  }

  get repositories(): Repository[] {
    return this.openRepositories.map(r => r.repository);
  }

  get svn(): Svn {
    return this._svn;
  }

  constructor(
    private _svn: Svn,
    policy: ConstructorPolicy,
    private extensionContact: ExtensionContext
  ) {
    if (policy !== ConstructorPolicy.Async) {
      throw new Error("Unsopported policy");
    }
    this.enabled = configuration.get<boolean>("enabled") === true;

    this.configurationChangeDisposable = workspace.onDidChangeConfiguration(
      this.onDidChangeConfiguration,
      this
    );

    return (async (): Promise<SourceControlManager> => {
      if (this.enabled) {
        await this.enable();
      }
      return this;
    })() as unknown as SourceControlManager;
  }

  private logRepositoryLifecycle(
    repository: Repository,
    message: string,
    reason: string = "repository-lifecycle"
  ): void {
    const now = new Date();
    const milliseconds = now.getMilliseconds().toString().padStart(3, "0");
    const timestamp = `${now.toTimeString().slice(0, 8)}.${milliseconds}`;
    const name = path.basename(repository.workspaceRoot);
    this.svn.logOutput(`[${timestamp}] [${name}] [${reason}] ${message}\n`);
  }

  public openRepositoriesSorted(): IOpenRepository[] {
    return this.openRepositories.sort(
      (a, b) =>
        b.repository.workspaceRoot.length - a.repository.workspaceRoot.length
    );
  }

  private onDidChangeConfiguration(): void {
    if (this.disposed) {
      return;
    }

    const enabled = configuration.get<boolean>("enabled") === true;

    this.maxDepth = configuration.get<number>("multipleFolders.depth", 0);

    if (enabled === this.enabled) {
      return;
    }

    this.enabled = enabled;
    this.lifecycleGeneration += 1;

    if (enabled) {
      this.enable();
    } else {
      this.disable();
    }
  }

  private async enable() {
    const lifecycleGeneration = this.lifecycleGeneration;
    const multipleFolders = configuration.get<boolean>(
      "multipleFolders.enabled",
      false
    );

    if (multipleFolders) {
      this.maxDepth = configuration.get<number>("multipleFolders.depth", 0);

      this.ignoreList = configuration.get("multipleFolders.ignore", []);
    }

    workspace.onDidChangeWorkspaceFolders(
      this.onDidChangeWorkspaceFolders,
      this,
      this.disposables
    );

    const fsWatcher = workspace.createFileSystemWatcher("**");
    this.disposables.push(fsWatcher);

    const onWorkspaceChange = anyEvent(
      fsWatcher.onDidChange,
      fsWatcher.onDidCreate,
      fsWatcher.onDidDelete
    );
    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri =>
        uri.scheme === "file" &&
        getSvnRepositoryPathFromMetadata(uri.fsPath) !== undefined &&
        !this.getRepository(uri)
    );
    onPossibleSvnRepositoryChange(
      this.onPossibleSvnRepositoryChange,
      this,
      this.disposables
    );
    fsWatcher.onDidCreate(
      uri => void this.onPossibleSvnRepositoryDirectoryCreate(uri),
      this,
      this.disposables
    );

    this.setState("initialized");

    await this.scanWorkspaceFolders(lifecycleGeneration);
  }

  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = getSvnRepositoryPathFromMetadata(
      uri.fsPath
    );
    if (possibleSvnRepositoryPath === undefined) {
      return;
    }

    this.eventuallyScanPossibleSvnRepository(possibleSvnRepositoryPath);
  }

  private async onPossibleSvnRepositoryDirectoryCreate(
    uri: Uri
  ): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    if (
      !this.isDiscoveryActive(lifecycleGeneration) ||
      uri.scheme !== "file" ||
      getSvnRepositoryPathFromMetadata(uri.fsPath) !== undefined ||
      isSvnMetadataLookalikeDirectory(uri.fsPath) ||
      this.hasExactRepository(uri.fsPath)
    ) {
      return;
    }

    try {
      const stats = await stat(uri.fsPath);
      if (
        !this.isDiscoveryActive(lifecycleGeneration) ||
        !stats.isDirectory() ||
        this.hasExactRepository(uri.fsPath)
      ) {
        return;
      }

      this.eventuallyScanPossibleSvnRepository(uri.fsPath, true);
    } catch (_error) {
      // The path may disappear again before the asynchronous stat completes.
    }
  }

  private hasExactRepository(candidatePath: string): boolean {
    const candidate = normalizePath(candidatePath);
    return this.openRepositories.some(({ repository }) => {
      return (
        normalizePath(repository.root) === candidate ||
        normalizePath(repository.workspaceRoot) === candidate
      );
    });
  }

  private isDiscoveryActive(lifecycleGeneration: number): boolean {
    return (
      !this.disposed &&
      this.enabled &&
      this.lifecycleGeneration === lifecycleGeneration
    );
  }

  private eventuallyScanPossibleSvnRepository(
    path: string,
    allowNested: boolean = false
  ) {
    if (this.disposed || !this.enabled) {
      return;
    }

    const existing = this.possibleSvnRepositoryPaths.get(path) || false;
    this.possibleSvnRepositoryPaths.set(path, existing || allowNested);
    this.eventuallyScanPossibleSvnRepositories();
  }

  @debounce(500)
  private eventuallyScanPossibleSvnRepositories(): void {
    if (this.disposed || !this.enabled) {
      this.possibleSvnRepositoryPaths.clear();
      return;
    }

    for (const [path, allowNested] of this.possibleSvnRepositoryPaths) {
      void this.tryOpenRepository(path, 1, {
        allowNested,
        recursive: !allowNested
      });
    }

    this.possibleSvnRepositoryPaths.clear();
  }

  private scanExternals(repository: Repository): void {
    const shouldScanExternals =
      configuration.get<boolean>("detectExternals") === true;

    if (!shouldScanExternals) {
      return;
    }

    repository.statusExternal
      .map(r => path.join(repository.workspaceRoot, r.path))
      .forEach(p => this.eventuallyScanPossibleSvnRepository(p));
  }

  private scanIgnored(repository: Repository): void {
    const shouldScan = configuration.get<boolean>("detectIgnored") === true;

    if (!shouldScan) {
      return;
    }

    repository.statusIgnored
      .map(r => path.join(repository.workspaceRoot, r.path))
      .forEach(p => this.eventuallyScanPossibleSvnRepository(p));
  }

  private disable(): void {
    cancelDebounces(this);
    this.openRepositories.slice().forEach(repository => repository.dispose());
    this.openRepositories = [];

    this.possibleSvnRepositoryPaths.clear();
    this.disposables = dispose(this.disposables);
  }

  private async onDidChangeWorkspaceFolders({
    added,
    removed
  }: WorkspaceFoldersChangeEvent) {
    const possibleRepositoryFolders = added.filter(
      folder => !this.getOpenRepository(folder.uri)
    );

    const openRepositoriesToDispose = removed
      .map(folder => this.getOpenRepository(folder.uri.fsPath))
      .filter(repository => !!repository)
      .filter(
        repository =>
          !(workspace.workspaceFolders || []).some(f =>
            repository!.repository.workspaceRoot.startsWith(f.uri.fsPath)
          )
      ) as IOpenRepository[];

    possibleRepositoryFolders.forEach(p =>
      this.tryOpenRepository(p.uri.fsPath)
    );
    openRepositoriesToDispose.forEach(r => r.dispose());
  }

  private async scanWorkspaceFolders(
    lifecycleGeneration: number,
    folders = workspace.workspaceFolders || []
  ) {
    for (const folder of folders) {
      if (!this.isDiscoveryActive(lifecycleGeneration)) {
        return;
      }
      const root = folder.uri.fsPath;
      await this.tryOpenRepository(root, 0, { lifecycleGeneration });
    }
  }

  private isDiscoveryCandidateOwned(
    path: string,
    allowNested: boolean
  ): boolean {
    // Pre-1.7 working copies have administration directories in every child.
    // Without wcroot-abspath, a nested candidate cannot override a known owner.
    if (!allowNested || semver.satisfies(this.svn.version, "<1.7.0")) {
      return !!this.getRepository(path);
    }

    return this.hasExactRepository(path);
  }

  public async tryOpenRepository(
    path: string,
    level = 0,
    {
      allowNested = false,
      recursive = true,
      lifecycleGeneration = this.lifecycleGeneration
    }: DiscoveryOptions = {}
  ): Promise<void> {
    if (
      !this.isDiscoveryActive(lifecycleGeneration) ||
      this.isDiscoveryCandidateOwned(path, allowNested)
    ) {
      return;
    }

    const checkParent = level === 0;

    const svnFolder = await isSvnFolder(path, checkParent);
    if (!this.isDiscoveryActive(lifecycleGeneration)) {
      return;
    }

    if (svnFolder) {
      const resourceConfig = workspace.getConfiguration("svn", Uri.file(path));

      const ignoredRepos = new Set(
        (resourceConfig.get<string[]>("ignoreRepositories") || []).map(p =>
          normalizePath(p)
        )
      );

      if (ignoredRepos.has(normalizePath(path))) {
        return;
      }

      try {
        const repositoryRoot = await this.svn.getRepositoryRoot(path);
        if (!this.isDiscoveryActive(lifecycleGeneration)) {
          return;
        }

        const baseRepository = await this.svn.open(repositoryRoot, path);
        if (
          !this.isDiscoveryActive(lifecycleGeneration) ||
          this.isDiscoveryCandidateOwned(path, allowNested)
        ) {
          return;
        }

        const repository = new Repository(
          baseRepository,
          this.extensionContact.secrets
        );

        this.registerDiscoveredRepository(
          repository,
          lifecycleGeneration,
          allowNested
        );
      } catch (err) {
        if (!this.isDiscoveryActive(lifecycleGeneration)) {
          return;
        }

        if (err instanceof SvnError) {
          if (err.svnErrorCode === svnErrorCodes.WorkingCopyIsTooOld) {
            await commands.executeCommand("svn.upgrade", path);
            return;
          }
        }
        console.error(err);
      }
      return;
    }

    const newLevel = level + 1;
    if (recursive && newLevel <= this.maxDepth) {
      let files: string[] | Buffer[] = [];

      try {
        files = await readdir(path);
      } catch (_error) {
        return;
      }

      if (!this.isDiscoveryActive(lifecycleGeneration)) {
        return;
      }

      for (const file of files) {
        const dir = path + "/" + file;
        let stats: Stats;

        try {
          stats = await stat(dir);
        } catch (_error) {
          continue;
        }

        if (!this.isDiscoveryActive(lifecycleGeneration)) {
          return;
        }

        if (
          stats.isDirectory() &&
          !matchAll(dir, this.ignoreList, { dot: true })
        ) {
          await this.tryOpenRepository(dir, newLevel, { lifecycleGeneration });
        }
      }
    }
  }

  private registerDiscoveredRepository(
    repository: Repository,
    lifecycleGeneration: number,
    allowNested: boolean,
    workspaceFolders = workspace.workspaceFolders || []
  ): void {
    if (!this.isDiscoveryActive(lifecycleGeneration)) {
      repository.dispose();
      return;
    }

    if (semver.satisfies(this.svn.version, "<1.7.0")) {
      if (allowNested) {
        this.provisionalLegacyRepositories.add(repository);
      }

      // Legacy directory metadata cannot identify the WC root. An automatic
      // child projection is provisional until a broader owner is discovered,
      // even if the two candidates arrived in different debounce batches.
      const workspaceOwners = new Set(
        workspaceFolders.map(folder => this.getRepository(folder.uri))
      );
      const children = this.openRepositories.filter(
        ({ repository: child }) =>
          this.provisionalLegacyRepositories.has(child) &&
          normalizePath(child.workspaceRoot) !==
            normalizePath(repository.workspaceRoot) &&
          !workspaceOwners.has(child) &&
          isDescendant(repository.workspaceRoot, child.workspaceRoot)
      );
      for (const child of children) {
        // Closing publishes an event; its listeners may disable the manager
        // or close another child synchronously.
        if (!this.isDiscoveryActive(lifecycleGeneration)) {
          break;
        }
        if (this.openRepositories.includes(child)) {
          child.dispose();
        }
      }
    }

    this.open(repository, lifecycleGeneration);
  }

  public async getRemoteRepository(uri: Uri): Promise<RemoteRepository> {
    return RemoteRepository.open(this.svn, uri);
  }

  public getRepository(hint: any): Repository | null {
    const liveRepository = this.getOpenRepository(hint);
    if (liveRepository && liveRepository.repository) {
      return liveRepository.repository;
    }

    return null;
  }

  public getOpenRepository(hint: any): IOpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.openRepositories.find(r => r.repository === hint);
    }

    if ((hint as any).repository instanceof Repository) {
      return this.openRepositories.find(
        r => r.repository === (hint as any).repository
      );
    }

    if (typeof hint === "string") {
      hint = Uri.file(hint);
    }

    if (hint instanceof Uri) {
      const owner = this.openRepositoriesSorted().find(liveRepository =>
        isDescendant(liveRepository.repository.workspaceRoot, hint.fsPath)
      );
      if (!owner) {
        return undefined;
      }

      for (const external of owner.repository.statusExternal) {
        const externalPath = path.join(
          owner.repository.workspaceRoot,
          external.path
        );
        if (isDescendant(externalPath, hint.fsPath)) {
          return undefined;
        }
      }
      for (const ignored of owner.repository.statusIgnored) {
        const ignoredPath = path.join(
          owner.repository.workspaceRoot,
          ignored.path
        );
        if (isDescendant(ignoredPath, hint.fsPath)) {
          return undefined;
        }
      }

      return owner;
    }

    for (const liveRepository of this.openRepositories) {
      const repository = liveRepository.repository;

      if (hint === repository.sourceControl) {
        return liveRepository;
      }

      if (hint === repository.changes) {
        return liveRepository;
      }
    }

    return undefined;
  }

  public async getRepositoryFromUri(uri: Uri): Promise<Repository | null> {
    const repository = this.getOpenRepository(uri)?.repository;
    if (!repository) {
      return null;
    }

    const resource = repository.getResourceFromFile(uri);
    if (resource) {
      return resource.type === Status.UNVERSIONED ||
        resource.type === Status.IGNORED
        ? null
        : repository;
    }

    if (repository.isInitialStatusPending) {
      this.logRepositoryLifecycle(
        repository,
        `initial status pending; skipping path validation: ${uri.fsPath}`,
        "repository-routing"
      );
      return repository;
    }

    // Share only concurrent lookups. A completed svn info is not a durable
    // version-control fact: files may change even with autorefresh disabled.
    const filePath = normalizePath(uri.fsPath);
    let validations = this.routingValidations.get(repository);
    if (!validations) {
      validations = new Map();
      this.routingValidations.set(repository, validations);
    }
    let validation = validations.get(filePath);
    if (!validation) {
      validation = this.validateRepositoryPath(repository, filePath);
      validations.set(filePath, validation);
    }
    try {
      const valid = await validation;
      if (
        this.routingValidations.get(repository) !== validations ||
        this.getOpenRepository(uri)?.repository !== repository
      ) {
        return null;
      }
      this.logRepositoryLifecycle(
        repository,
        `path validation ${valid ? "succeeded" : "rejected"}: ${filePath}`,
        "repository-routing"
      );
      return valid ? repository : null;
    } finally {
      if (validations.get(filePath) === validation) {
        validations.delete(filePath);
      }
    }
  }

  private async validateRepositoryPath(
    repository: Repository,
    path: string
  ): Promise<boolean> {
    try {
      this.logRepositoryLifecycle(
        repository,
        `validating path with svn info: ${path}`,
        "repository-routing"
      );

      await repository.info(path);

      return true;
    } catch (_error) {
      return false;
    }
  }

  private open(repository: Repository, lifecycleGeneration: number): void {
    if (!this.isDiscoveryActive(lifecycleGeneration)) {
      repository.dispose();
      return;
    }

    this.logRepositoryLifecycle(repository, "opened; initial status pending");
    void repository.initialStatusSettled.then(() => {
      if (repository.state !== RepositoryState.Disposed) {
        this.logRepositoryLifecycle(repository, "initial status settled");
      }
    });

    const quickDiffLoggingListener = repository.onDidChangeStatus(() => {
      if (repository.sourceControl.quickDiffProvider !== repository) {
        return;
      }

      this.logRepositoryLifecycle(repository, "quick diff enabled");
      quickDiffLoggingListener.dispose();
    });

    const onDidDisappearRepository = filterEvent(
      repository.onDidChangeState,
      state => state === RepositoryState.Disposed
    );

    const disappearListener = onDidDisappearRepository(() => dispose());

    const changeListener = repository.onDidChangeRepository(uri => {
      this.routingValidations.delete(repository);
      this._onDidChangeRepository.fire({ repository, uri });
    });

    const changeStatus = repository.onDidChangeStatus(() => {
      this.routingValidations.delete(repository);
      this._onDidChangeStatusRepository.fire(repository);
    });

    const statusListener = repository.onDidChangeStatus(() => {
      this.scanExternals(repository);
      this.scanIgnored(repository);
    });
    this.scanExternals(repository);
    this.scanIgnored(repository);

    const dispose = () => {
      this.routingValidations.delete(repository);
      this.logRepositoryLifecycle(repository, "closed");
      quickDiffLoggingListener.dispose();
      disappearListener.dispose();
      changeListener.dispose();
      changeStatus.dispose();
      statusListener.dispose();
      repository.dispose();

      this.openRepositories = this.openRepositories.filter(
        e => e !== openRepository
      );
      this._onDidCloseRepository.fire(repository);
    };

    const openRepository = { repository, dispose };
    this.openRepositories.push(openRepository);
    this._onDidOpenRepository.fire(repository);
  }

  public close(repository: Repository): void {
    const openRepository = this.getOpenRepository(repository);

    if (!openRepository) {
      return;
    }

    openRepository.dispose();
  }

  public async pickRepository() {
    if (this.openRepositories.length === 0) {
      throw new Error("There are no available repositories");
    }

    const picks: any[] = this.repositories.map(repository => {
      return {
        label: path.basename(repository.root),
        repository
      };
    });
    const placeHolder = "Choose a repository";
    const pick = await window.showQuickPick(picks, { placeHolder });

    return pick && pick.repository;
  }

  public async upgradeWorkingCopy(folderPath: string): Promise<boolean> {
    try {
      const result = await this.svn.exec(folderPath, ["upgrade"]);
      return result.exitCode === 0;
    } catch (e) {
      console.log(e);
    }
    return false;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.enabled = false;
    this.lifecycleGeneration += 1;
    this.disable();
    this.configurationChangeDisposable.dispose();
  }
}
