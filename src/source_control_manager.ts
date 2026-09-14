import type { Stats } from "node:fs";
import * as path from "path";
import * as semver from "semver";
import {
  commands,
  ConfigurationChangeEvent,
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
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
import { boundedInteger } from "./helpers/settingValues";
import { configuration } from "./helpers/configuration";
import { RemoteRepository } from "./remoteRepository";
import { Repository } from "./repository";
import { Svn, svnErrorCodes } from "./svn";
import SvnError from "./svnError";
import {
  anyEvent,
  filterEvent,
  IDisposable,
  isDescendant,
  getSvnDir,
  isSvnFolder,
  normalizePath,
  eventToPromise
} from "./util";
import { matchAll } from "./util/globMatch";
import { disposeResources } from "./lifecycle";

type State = "uninitialized" | "initialized" | "disposed";

interface DiscoveryOptions {
  allowNested?: boolean;
  recursive?: boolean;
  lifecycleGeneration?: number;
  workspaceFolderGeneration?: number;
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
  private sortedOpenRepositories?: IOpenRepository[];
  private disposables: Disposable[] = [];
  private enabled = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private workspaceFolderGeneration = 0;
  private pendingWorkspaceFolderDiscoveries = new Map<
    string,
    { folder: WorkspaceFolder; generation: number }
  >();
  private enableTask: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
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
    if (this.disposed) {
      return Promise.reject(new Error("Source control manager is disposed"));
    }
    if (this._state === "initialized") {
      return Promise.resolve();
    }

    return eventToPromise(
      filterEvent(this.onDidchangeState, s => s !== "uninitialized")
    ).then(state => {
      if (state === "disposed") {
        throw new Error("Source control manager is disposed");
      }
    });
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
    if (
      policy !== ConstructorPolicy.Async &&
      policy !== ConstructorPolicy.LateInit
    ) {
      throw new Error("Unsopported policy");
    }
    this.configurationChangeDisposable = workspace.onDidChangeConfiguration(
      this.onDidChangeConfiguration,
      this
    );

    if (policy === ConstructorPolicy.Async) {
      return this.initialize().then(
        () => this
      ) as unknown as SourceControlManager;
    }
  }

  public initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      try {
        if (this.disposed) {
          throw new Error("Source control manager is disposed");
        }
        this.setEnabled(configuration.get<boolean>("enabled") === true);
        let task: Promise<void>;
        do {
          task = this.enableTask;
          try {
            await task;
          } catch (error) {
            if (task === this.enableTask) {
              throw error;
            }
          }
        } while (task !== this.enableTask);
        if (this.disposed) {
          throw new Error("Source control manager is disposed");
        }
        // A disabled manager is also ready; restored documents must not hang.
        this.setState("initialized");
      } catch (error) {
        this.dispose();
        throw error;
      }
    })());
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
    if (
      !this.sortedOpenRepositories ||
      this.sortedOpenRepositories.length !== this.openRepositories.length
    ) {
      this.sortedOpenRepositories = [...this.openRepositories].sort(
        (a, b) =>
          b.repository.workspaceRoot.length - a.repository.workspaceRoot.length
      );
    }
    return this.sortedOpenRepositories;
  }

  private onDidChangeConfiguration(event: ConfigurationChangeEvent): void {
    if (
      this.disposed ||
      !["svn.enabled", "svn.multipleFolders"].some(section =>
        event.affectsConfiguration(section)
      )
    ) {
      return;
    }

    this.updateDiscoverySettings();
    if (event.affectsConfiguration("svn.enabled")) {
      this.setEnabled(configuration.get<boolean>("enabled") === true);
    }
    void this.enableTask.catch(error => {
      this.svn.logOutput(
        `[activation] Unable to enable SVN: ${String(error)}\n`
      );
    });
  }

  private updateDiscoverySettings(): void {
    const recursive = configuration.get<boolean>(
      "multipleFolders.enabled",
      false
    );
    this.maxDepth = recursive
      ? boundedInteger(configuration.get("multipleFolders.depth"), 4, 0, 100)
      : 0;
    this.ignoreList = recursive
      ? configuration.get<string[]>("multipleFolders.ignore", [])
      : [];
  }

  private setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }

    this.enabled = enabled;
    this.lifecycleGeneration += 1;

    if (enabled) {
      this.enableTask = this.enable();
    } else {
      this.enableTask = Promise.resolve();
      this.disable();
    }
  }

  private async enable() {
    const lifecycleGeneration = this.lifecycleGeneration;
    try {
      this.updateDiscoverySettings();

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

      await this.scanWorkspaceFolders(lifecycleGeneration);
      if (this.isDiscoveryActive(lifecycleGeneration)) {
        this.setState("initialized");
      }
    } catch (error) {
      // A failed obsolete scan must not tear down a newer enable session.
      if (!this.isDiscoveryActive(lifecycleGeneration)) {
        return;
      }
      this.enabled = false;
      this.lifecycleGeneration += 1;
      this.disable();
      throw error;
    }
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
    const repositories = this.openRepositories;
    const disposables = this.disposables;
    this.openRepositories = [];
    this.sortedOpenRepositories = undefined;
    this.disposables = [];
    this.possibleSvnRepositoryPaths.clear();
    this.pendingWorkspaceFolderDiscoveries.clear();
    // Detach the old session before close listeners can enable a new one.
    disposeResources(disposables);
    disposeResources(repositories);
  }

  private async onDidChangeWorkspaceFolders({
    added,
    removed
  }: WorkspaceFoldersChangeEvent) {
    const workspaceFolderGeneration = ++this.workspaceFolderGeneration;
    const currentFolders = this.currentWorkspaceFolders();
    const survivingFolders =
      this.disposeRepositoriesUncoveredByWorkspaceRemoval(
        removed,
        currentFolders
      );
    const currentRoots = new Set(
      currentFolders.map(folder => normalizePath(folder.uri.fsPath))
    );

    for (const root of this.pendingWorkspaceFolderDiscoveries.keys()) {
      if (!currentRoots.has(root)) {
        this.pendingWorkspaceFolderDiscoveries.delete(root);
      }
    }
    for (const folder of [...added, ...survivingFolders]) {
      const root = normalizePath(folder.uri.fsPath);
      this.pendingWorkspaceFolderDiscoveries.set(root, {
        folder,
        generation: workspaceFolderGeneration
      });
    }

    for (const [root, pending] of this.pendingWorkspaceFolderDiscoveries) {
      if (this.getOpenRepository(pending.folder.uri)) {
        this.pendingWorkspaceFolderDiscoveries.delete(root);
        continue;
      }
      const request = {
        folder: pending.folder,
        generation: workspaceFolderGeneration
      };
      this.pendingWorkspaceFolderDiscoveries.set(root, request);
      void Promise.resolve(
        this.tryOpenRepository(request.folder.uri.fsPath, 0, {
          workspaceFolderGeneration
        })
      ).finally(() => {
        if (this.pendingWorkspaceFolderDiscoveries.get(root) === request) {
          this.pendingWorkspaceFolderDiscoveries.delete(root);
        }
      });
    }
  }

  private currentWorkspaceFolders(): readonly WorkspaceFolder[] {
    return workspace.workspaceFolders || [];
  }

  private disposeRepositoriesUncoveredByWorkspaceRemoval(
    removed: readonly WorkspaceFolder[],
    remaining: readonly WorkspaceFolder[] = workspace.workspaceFolders || []
  ): WorkspaceFolder[] {
    const removedRoots = removed.map(folder => folder.uri.fsPath);
    const remainingRoots = remaining.map(folder => folder.uri.fsPath);
    const repositories = this.openRepositories.filter(({ repository }) => {
      const workspaceRoot = repository.workspaceRoot;
      return (
        removedRoots.some(root => isDescendant(root, workspaceRoot)) &&
        !remainingRoots.some(root => isDescendant(root, workspaceRoot))
      );
    });
    const survivingFolders = remaining.filter(folder =>
      repositories.some(({ repository }) =>
        isDescendant(repository.workspaceRoot, folder.uri.fsPath)
      )
    );

    for (const repository of repositories) {
      // Closing publishes an event; its listeners may synchronously close
      // another entry selected by this same workspace transition.
      if (this.openRepositories.includes(repository)) {
        repository.dispose();
      }
    }

    return survivingFolders;
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

  private isDiscoveryRequestActive(
    lifecycleGeneration: number,
    workspaceFolderGeneration?: number
  ): boolean {
    return (
      this.isDiscoveryActive(lifecycleGeneration) &&
      (workspaceFolderGeneration === undefined ||
        workspaceFolderGeneration === this.workspaceFolderGeneration)
    );
  }

  public async tryOpenRepository(
    path: string,
    level = 0,
    {
      allowNested = false,
      recursive = true,
      lifecycleGeneration = this.lifecycleGeneration,
      workspaceFolderGeneration
    }: DiscoveryOptions = {}
  ): Promise<void> {
    if (
      !this.isDiscoveryRequestActive(
        lifecycleGeneration,
        workspaceFolderGeneration
      ) ||
      this.isDiscoveryCandidateOwned(path, allowNested)
    ) {
      return;
    }

    const checkParent = level === 0;

    const svnFolder = await isSvnFolder(path, checkParent);
    if (
      !this.isDiscoveryRequestActive(
        lifecycleGeneration,
        workspaceFolderGeneration
      )
    ) {
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
        if (
          !this.isDiscoveryRequestActive(
            lifecycleGeneration,
            workspaceFolderGeneration
          )
        ) {
          return;
        }

        const baseRepository = await this.svn.open(repositoryRoot, path);
        if (
          !this.isDiscoveryRequestActive(
            lifecycleGeneration,
            workspaceFolderGeneration
          ) ||
          this.isDiscoveryCandidateOwned(path, allowNested)
        ) {
          return;
        }

        const repository = new Repository(
          baseRepository,
          this.extensionContact.secrets,
          this.extensionContact.workspaceState
        );

        this.registerDiscoveredRepository(
          repository,
          lifecycleGeneration,
          allowNested,
          undefined,
          workspaceFolderGeneration
        );
      } catch (err) {
        if (
          !this.isDiscoveryRequestActive(
            lifecycleGeneration,
            workspaceFolderGeneration
          )
        ) {
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

      if (
        !this.isDiscoveryRequestActive(
          lifecycleGeneration,
          workspaceFolderGeneration
        )
      ) {
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

        if (
          !this.isDiscoveryRequestActive(
            lifecycleGeneration,
            workspaceFolderGeneration
          )
        ) {
          return;
        }

        if (
          stats.isDirectory() &&
          !matchAll(dir, this.ignoreList, { dot: true })
        ) {
          await this.tryOpenRepository(dir, newLevel, {
            lifecycleGeneration,
            workspaceFolderGeneration
          });
        }
      }
    }
  }

  private registerDiscoveredRepository(
    repository: Repository,
    lifecycleGeneration: number,
    allowNested: boolean,
    workspaceFolders = workspace.workspaceFolders || [],
    workspaceFolderGeneration?: number
  ): void {
    if (
      !this.isDiscoveryRequestActive(
        lifecycleGeneration,
        workspaceFolderGeneration
      )
    ) {
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
        if (
          !this.isDiscoveryRequestActive(
            lifecycleGeneration,
            workspaceFolderGeneration
          )
        ) {
          break;
        }
        if (this.openRepositories.includes(child)) {
          child.dispose();
        }
      }
    }

    if (
      !this.isDiscoveryRequestActive(
        lifecycleGeneration,
        workspaceFolderGeneration
      )
    ) {
      repository.dispose();
      return;
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

      // getInfo explicitly bypasses BaseRepository's two-minute metadata cache.
      // info() is suitable for display metadata, not current SVN membership.
      await repository.getInfo(path);

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
      this.sortedOpenRepositories = undefined;
      this._onDidCloseRepository.fire(repository);
    };

    const openRepository = { repository, dispose };
    this.openRepositories.push(openRepository);
    this.sortedOpenRepositories = undefined;
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
    this.setState("disposed");
    this._onDidChangeState.dispose();
    this._onDidOpenRepository.dispose();
    this._onDidCloseRepository.dispose();
    this._onDidChangeRepository.dispose();
    this._onDidChangeStatusRepository.dispose();
  }
}
