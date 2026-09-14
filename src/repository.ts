import { remoteIntervalSeconds } from "./helpers/settingValues";
import * as path from "path";
import { clearInterval, setInterval } from "timers";
import {
  commands,
  CancellationTokenSource,
  Disposable,
  Event,
  EventEmitter,
  Memento,
  ProgressLocation,
  scm,
  SecretStorage,
  SourceControl,
  SourceControlInputBox,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode";
import {
  IAuth,
  IFileStatus,
  IOperations,
  ISvnInfo,
  ISvnResourceGroup,
  Operation,
  RepositoryState,
  Status,
  SvnDepth,
  SvnUriAction,
  ISvnPathChange,
  IStoredAuth,
  ISvnListItem
} from "./common/types";
import {
  cancelDebounces,
  debounce,
  globalSequentialize,
  memoize,
  throttle
} from "./decorators";
import { exists } from "./fs";
import { configuration } from "./helpers/configuration";
import OperationsImpl from "./operationsImpl";
import { PathNormalizer } from "./pathNormalizer";
import { IRemoteRepository } from "./remoteRepository";
import {
  StatusSnapshotStore,
  workingCopyIdentity,
  selectStartupTargets,
  mergeStartupStatus,
  snapshotPathKey,
  isSnapshotPath,
  STARTUP_MAX_FILES,
  retainRemoteStatus
} from "./statusSnapshot";
import { Resource } from "./resource";
import { StatusBarCommands } from "./statusbar/statusBarCommands";
import { svnErrorCodes } from "./svn";
import SvnError from "./svnError";
import { SvnCancellationError, waitForSvn } from "./svnProcess";
import { Repository as BaseRepository } from "./svnRepository";
import { toSvnUri } from "./uri";
import {
  anyEvent,
  dispose,
  filterEvent,
  getSvnDir,
  isDescendant,
  isReadOnly,
  timeout,
  toDisposable
} from "./util";
import { match, matchAll } from "./util/globMatch";
import { RepositoryFilesWatcher } from "./watchers/repositoryFilesWatcher";
import { withWorkingCopyMutationLock } from "./workingCopyMutationLock";

function shouldShowProgress(operation: Operation): boolean {
  switch (operation) {
    case Operation.CurrentBranch:
    case Operation.Show:
    case Operation.Info:
      return false;
    default:
      return true;
  }
}

export class Repository implements IRemoteRepository {
  public sourceControl: SourceControl;
  public statusBar: StatusBarCommands;
  public changes: ISvnResourceGroup;
  public unversioned: ISvnResourceGroup;
  public staged?: ISvnResourceGroup;
  public stagedChangelists: Map<string, string> = new Map();
  public remoteChanges?: ISvnResourceGroup;
  public changelists: Map<string, ISvnResourceGroup> = new Map();
  public conflicts: ISvnResourceGroup;
  public statusIgnored: IFileStatus[] = [];
  public statusExternal: IFileStatus[] = [];
  private disposables: Disposable[] = [];
  public currentBranch = "";
  public remoteChangedFiles: number = 0;
  public isIncomplete: boolean = false;
  public needCleanUp: boolean = false;
  private remoteChangedUpdateInterval?: ReturnType<typeof setInterval>;
  private deletedUris: Uri[] = [];
  private canSaveAuth: boolean = false;
  private _initialStatusPending = true;
  public readonly initialStatusSettled: Promise<void>;
  private disposed = false;
  private statusSnapshot: IFileStatus[] | undefined;
  private snapshotPreview = false;
  private remotePollPending = false;
  private remoteSchedule = 0;

  public getStatusSnapshot(): IFileStatus[] | undefined {
    return this.statusSnapshot?.map(status => ({ ...status }));
  }
  private snapshotStore?: StatusSnapshotStore;
  private hasLiveStatus = false;
  private readonly previewResources = new WeakSet<Resource>();
  private readonly startupAbort = new AbortController();
  private startupPreviewReady = false;
  private startupFileVersion = 0;
  private startupDeletionPending = false;
  private startupFileScanRunning = false;
  private readonly startupFileTargets = new Map<string, string>();
  private readonly startupFileResults = new Map<string, IFileStatus>();
  private readonly startupFilesSeen = new Set<string>();

  private _onDidDispose = new EventEmitter<void>();
  private readonly onDidDispose: Event<void> = this._onDidDispose.event;

  public get isInitialStatusPending(): boolean {
    return this._initialStatusPending;
  }

  private lastPromptAuth?: Thenable<IAuth | undefined>;

  private _fsWatcher: RepositoryFilesWatcher;
  public get fsWatcher() {
    return this._fsWatcher;
  }

  private _onDidChangeRepository = new EventEmitter<Uri>();
  public readonly onDidChangeRepository: Event<Uri> =
    this._onDidChangeRepository.event;

  private _onDidChangeState = new EventEmitter<RepositoryState>();
  public readonly onDidChangeState: Event<RepositoryState> =
    this._onDidChangeState.event;

  private _onDidChangeStatus = new EventEmitter<void>();
  public readonly onDidChangeStatus: Event<void> =
    this._onDidChangeStatus.event;

  private _onDidRebuildStatusProjection = new EventEmitter<void>();
  public readonly onDidRebuildStatusProjection: Event<void> =
    this._onDidRebuildStatusProjection.event;

  private _onDidChangeRemoteChangedFiles = new EventEmitter<void>();
  public readonly onDidChangeRemoteChangedFile: Event<void> =
    this._onDidChangeRemoteChangedFiles.event;

  private _onRunOperation = new EventEmitter<Operation>();
  public readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

  private _onDidRunOperation = new EventEmitter<Operation>();
  public readonly onDidRunOperation: Event<Operation> =
    this._onDidRunOperation.event;

  @memoize
  get onDidChangeOperations(): Event<void> {
    return anyEvent(
      this.onRunOperation as Event<any>,
      this.onDidRunOperation as Event<any>
    );
  }

  private _operations = new OperationsImpl();
  get operations(): IOperations {
    return this._operations;
  }

  private _state = RepositoryState.Idle;
  get state(): RepositoryState {
    return this._state;
  }
  set state(state: RepositoryState) {
    this._state = state;
    this._onDidChangeState.fire(state);

    this.changes.resourceStates = [];
    this.unversioned.resourceStates = [];
    if (this.staged) {
      this.staged.resourceStates = [];
    }
    this.stagedChangelists.clear();
    this.conflicts.resourceStates = [];
    this.changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });

    if (this.remoteChanges) {
      this.remoteChanges.dispose();
    }

    this.isIncomplete = false;
    this.needCleanUp = false;
  }

  get root(): string {
    return this.repository.root;
  }

  get workspaceRoot(): string {
    return this.repository.workspaceRoot;
  }

  /** 'svn://repo.x/branches/b1' e.g. */
  get branchRoot(): Uri {
    return Uri.parse(this.repository.info.url);
  }

  get inputBox(): SourceControlInputBox {
    return this.sourceControl.inputBox;
  }

  get username(): string | undefined {
    return this.repository.username;
  }

  set username(username: string | undefined) {
    this.repository.username = username;
  }

  get password(): string | undefined {
    return this.repository.password;
  }

  set password(password: string | undefined) {
    this.repository.password = password;
  }

  constructor(
    public repository: BaseRepository,
    private secrets: SecretStorage,
    snapshotState?: Memento
  ) {
    if (snapshotState) {
      this.snapshotStore = new StatusSnapshotStore(
        snapshotState,
        repository.root,
        repository.workspaceRoot
      );
    }
    repository.setInfoOwner(() => !this.disposed);
    this._fsWatcher = new RepositoryFilesWatcher(repository.root);
    this.disposables.push(this._fsWatcher);

    this._fsWatcher.onDidAny(this.onFSChange, this, this.disposables);
    this._fsWatcher.onDidSvnAny(
      async (e: Uri) => {
        await this.onDidAnyFileChanged(e);
      },
      this,
      this.disposables
    );

    this.sourceControl = scm.createSourceControl(
      "svn",
      "SVN",
      Uri.file(repository.workspaceRoot)
    );

    this.sourceControl.count = 0;
    this.sourceControl.inputBox.placeholder =
      "Message (press Ctrl+Enter to commit)";
    this.sourceControl.acceptInputCommand = {
      command: "svn.commitWithMessage",
      title: "commit",
      arguments: [this.sourceControl]
    };
    this.disposables.push(this.sourceControl);

    this.statusBar = new StatusBarCommands(this);
    this.disposables.push(this.statusBar);
    this.statusBar.onDidChange(
      () => (this.sourceControl.statusBarCommands = this.statusBar.commands),
      null,
      this.disposables
    );

    // VS Code renders SCM resource groups in creation order. Keep the Git-like
    // staging group above Changes by creating it first; StagingCoordinator only
    // owns its contents and staging metadata, not the group's lifetime.
    this.staged = this.sourceControl.createResourceGroup(
      "staged",
      "Staged Changes"
    ) as ISvnResourceGroup;
    this.changes = this.sourceControl.createResourceGroup(
      "changes",
      "Changes"
    ) as ISvnResourceGroup;
    this.conflicts = this.sourceControl.createResourceGroup(
      "conflicts",
      "Conflicts"
    ) as ISvnResourceGroup;
    this.unversioned = this.sourceControl.createResourceGroup(
      "unversioned",
      "Unversioned"
    ) as ISvnResourceGroup;

    this.staged.repository = this;
    this.changes.repository = this;
    this.conflicts.repository = this;
    this.unversioned.repository = this;
    this.staged.hideWhenEmpty = true;
    this.changes.hideWhenEmpty = true;
    this.unversioned.hideWhenEmpty = true;
    this.conflicts.hideWhenEmpty = true;

    this.disposables.push(this.staged);
    this.disposables.push(this.changes);
    this.disposables.push(this.conflicts);

    // The this.unversioned can recreated by update state model
    this.disposables.push(toDisposable(() => this.unversioned.dispose()));

    // Dispose the setInterval of Remote Changes
    this.disposables.push(
      toDisposable(() => {
        if (this.remoteChangedUpdateInterval) {
          clearInterval(this.remoteChangedUpdateInterval);
        }
      })
    );

    // For each deleted file, append to list
    this._fsWatcher.onDidWorkspaceDelete(
      uri => this.deletedUris.push(uri),
      this,
      this.disposables
    );

    // Only check deleted files after the status list is fully updated
    this.onDidChangeStatus(this.actionForDeletedFiles, this, this.disposables);

    const quickDiffStatusListener: Disposable = this.onDidChangeStatus(() => {
      this.sourceControl.quickDiffProvider = this;
      quickDiffStatusListener.dispose();
    });
    this.disposables.push(quickDiffStatusListener);

    const remoteChangesEnabled =
      remoteIntervalSeconds(
        configuration.get("remoteChanges.checkFrequency", 300)
      ) > 0;

    this.createRemoteChangedInterval();

    // A remote status includes the local working-copy state as well, so use a
    // single initial scan instead of running local and remote status back-to-back.
    const initialStatus = this.run(
      remoteChangesEnabled ? Operation.StatusRemote : Operation.Status,
      async () => {
        await this.restoreStartupStatus();
        this.startupPreviewReady = true;
        if (this.startupFileTargets.size) this.scheduleStartupFileScan();
      },
      true
    );

    this.initialStatusSettled = initialStatus
      .catch(error => {
        if (!this.disposed) {
          console.error("Unable to load initial SVN status", error);
          window.showErrorMessage(
            "Unable to refresh SVN status. See SVN output for details."
          );
        }
      })
      .then(() => {
        this._initialStatusPending = false;
        this.startupFileTargets.clear();
        this.startupFileResults.clear();
        this.startupFilesSeen.clear();
      });

    // On change config, dispose current interval and create a new.
    this.disposables.push(
      configuration.onDidChange(e => {
        if (e.affectsConfiguration("svn.remoteChanges.checkFrequency")) {
          if (this.remoteChangedUpdateInterval) {
            clearInterval(this.remoteChangedUpdateInterval);
          }

          this.createRemoteChangedInterval();

          this.pollRemoteChanges();
        }

        if (
          [
            "svn.sourceControl.hideUnversioned",
            "svn.sourceControl.countUnversioned",
            "svn.sourceControl.ignore",
            "svn.sourceControl.ignoreOnStatusCount",
            "svn.diff.withHead",
            "svn.sourceControl.changesLeftClick"
          ].some(key => e.affectsConfiguration(key)) &&
          this.statusSnapshot
        ) {
          this.applyStatus(
            this.statusSnapshot,
            true,
            this.snapshotPreview,
            false
          );
        }

        if (
          e.affectsConfiguration(
            "svn.sourceControl.combineExternalIfSameServer"
          )
        ) {
          this.fullStatus();
        }
      })
    );

    // The SVN configuration helper intentionally filters out non-SVN events.
    this.disposables.push(
      workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("files.exclude") && this.statusSnapshot) {
          this.applyStatus(
            this.statusSnapshot,
            true,
            this.snapshotPreview,
            false
          );
        }
      })
    );

    this.disposables.push(
      workspace.onDidSaveTextDocument(document => {
        this.onDidSaveTextDocument(document);
      })
    );
  }

  @debounce(1000)
  private async onDidAnyFileChanged(e: Uri) {
    await this.repository.updateInfo();
    this.notifyRepositoryChanged(e);
  }

  public notifyRepositoryChanged(uri: Uri): void {
    if (this.disposed || !this.repository.isInfoCurrent) {
      return;
    }
    this._onDidChangeRepository.fire(uri);
  }

  private createRemoteChangedInterval() {
    this.remoteSchedule++;
    const updateFreq = remoteIntervalSeconds(
      configuration.get("remoteChanges.checkFrequency", 300)
    );
    if (!updateFreq) return;
    this.remoteChangedUpdateInterval = setInterval(
      () => this.pollRemoteChanges(),
      1000 * updateFreq
    );
  }

  private async pollRemoteChanges(): Promise<void> {
    if (this.remotePollPending || this.disposed) return;
    const schedule = this.remoteSchedule;
    this.remotePollPending = true;
    try {
      await this.initialStatusSettled;
      if (
        !(await this.whenIdleAndFocused()) ||
        schedule !== this.remoteSchedule ||
        !remoteIntervalSeconds(
          configuration.get("remoteChanges.checkFrequency", 300)
        )
      )
        return;
      await this.run(Operation.StatusRemote);
    } catch (error) {
      if (!this.disposed)
        console.error("Unable to check remote SVN changes", error);
    } finally {
      this.remotePollPending = false;
    }
  }

  /**
   * Check all recently deleted files and compare with svn status "missing"
   */
  @debounce(1000)
  private async actionForDeletedFiles() {
    if (!this.hasLiveStatus || this.disposed || !this.deletedUris.length) {
      return;
    }

    const allUris = this.deletedUris;
    this.deletedUris = [];

    const actionForDeletedFiles = configuration.get<string>(
      "delete.actionForDeletedFiles",
      "prompt"
    );

    if (actionForDeletedFiles === "none") {
      return;
    }

    const resources = allUris
      .map(uri => this.getResourceFromFile(uri))
      .filter(
        resource => resource && resource.type === Status.MISSING
      ) as Resource[];

    let uris = resources.map(resource => resource.resourceUri);

    if (!uris.length) {
      return;
    }

    const ignoredRulesForDeletedFiles = configuration.get<string[]>(
      "delete.ignoredRulesForDeletedFiles",
      []
    );
    const rules = ignoredRulesForDeletedFiles.map(ignored => match(ignored));

    if (rules.length) {
      uris = uris.filter(uri => {
        // Check first for relative URL (Better for workspace configuration)
        const relativePath = this.repository.removeAbsolutePath(uri.fsPath);

        return !rules.some(
          rule => rule.match(relativePath) || rule.match(uri.fsPath)
        );
      });
    }

    if (!uris.length) {
      return;
    }

    if (actionForDeletedFiles === "remove") {
      return this.removeFiles(
        uris.map(uri => uri.fsPath),
        false
      );
    } else if (actionForDeletedFiles === "prompt") {
      return commands.executeCommand("svn.promptRemove", ...uris);
    }

    return;
  }

  public async updateRemoteChangedFiles(): Promise<void> {
    await this.initialStatusSettled;
    while (!this.disposed && !this.operations.isIdle()) {
      if (!(await this.waitForEventOrDispose(this.onDidRunOperation))) return;
    }
    if (!this.disposed) await this.run(Operation.StatusRemote);
  }

  private onFSChange(_uri: Uri): void {
    const autorefresh = configuration.get<boolean>("autorefresh");

    if (!autorefresh) {
      return;
    }

    if (!this.operations.isIdle()) {
      return;
    }

    this.eventuallyUpdateWhenIdleAndWait();
  }

  @debounce(1000)
  private eventuallyUpdateWhenIdleAndWait(): void {
    this.updateWhenIdleAndWait();
  }

  @throttle
  private async updateWhenIdleAndWait(): Promise<void> {
    if (!(await this.whenIdleAndFocused())) {
      return;
    }

    await this.status();
    await timeout(5000);
  }

  private waitForEventOrDispose<T>(event: Event<T>): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>(resolve => {
      let listeners: Disposable[] = [];
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        listeners = dispose(listeners);
        resolve(value);
      };

      listeners = [
        event(() => finish(true)),
        this.onDidDispose(() => finish(false))
      ];
    });
  }

  public async whenIdle(): Promise<boolean> {
    while (!this.disposed && !this.operations.isIdle()) {
      if (!(await this.waitForEventOrDispose(this.onDidRunOperation))) {
        return false;
      }
    }

    return !this.disposed;
  }

  public async whenIdleAndFocused(): Promise<boolean> {
    while (!this.disposed) {
      if (!(await this.whenIdle())) {
        return false;
      }

      if (!window.state.focused) {
        const onDidFocusWindow = filterEvent(
          window.onDidChangeWindowState,
          e => e.focused
        );
        if (!(await this.waitForEventOrDispose(onDidFocusWindow))) {
          return false;
        }
        continue;
      }

      return true;
    }

    return false;
  }

  @throttle
  public async updateModelState(checkRemoteChanges: boolean = false) {
    return this.updateModelStateSequential(checkRemoteChanges, false);
  }

  @globalSequentialize("updateModelState")
  private async updateModelStateSequential(
    checkRemoteChanges: boolean,
    forceFullStatus: boolean
  ) {
    if (this.disposed) return;
    const combineExternal = configuration.get<boolean>(
      "sourceControl.combineExternalIfSameServer",
      false
    );
    let statuses = await this.retryRun(() =>
      this.repository.getStatus({
        includeIgnored: true,
        includeExternals: combineExternal,
        checkRemoteChanges,
        resolveExternalRepositoryUuid: combineExternal,
        forceFull: forceFullStatus
      })
    );
    if (this.disposed) return;
    if (!this.hasLiveStatus && this.isInitialStatusPending) {
      // A missing directory cannot prove descendant status through a shallow
      // check. Reconcile locally before accepting a full result read before deletion.
      while (this.startupDeletionPending) {
        this.startupDeletionPending = false;
        // This scan supersedes earlier local evidence. Only checks started
        // during this new scan may overlay its result.
        this.startupFileVersion++;
        this.startupFileResults.clear();
        const local = await this.retryRun(() =>
          this.repository.getStatus({
            includeIgnored: true,
            includeExternals: combineExternal,
            checkRemoteChanges: false,
            resolveExternalRepositoryUuid: combineExternal,
            forceFull: true
          })
        );
        if (this.disposed) return;
        statuses = retainRemoteStatus(local, statuses);
      }
      // The full scan may have read these paths before their newer local checks.
      const updates = [...this.startupFileResults.values()];
      statuses = mergeStartupStatus(
        statuses,
        updates.map(s => s.path),
        updates
      );
    }
    this.hasLiveStatus = true;
    this.applyStatus(statuses, checkRemoteChanges);
    await this.persistStatus(statuses);
    if (this.disposed) return;
    const branch = await this.getCurrentBranch();
    if (!this.disposed) this.currentBranch = branch;
  }

  /** Both restored and live data use the same projection, with no implicit mutations. */
  private applyStatus(
    statuses: IFileStatus[],
    checkRemoteChanges: boolean,
    preview = false,
    publishStatus = true
  ): void {
    if (this.disposed) return;
    if (!checkRemoteChanges && this.statusSnapshot) {
      statuses = retainRemoteStatus(statuses, this.statusSnapshot);
    }
    this.statusSnapshot = statuses.map(status => ({ ...status }));
    this.snapshotPreview = preview;
    const changes: Resource[] = [];
    const unversioned: Resource[] = [];
    const conflicts: Resource[] = [];
    const changelists: Map<string, Resource[]> = new Map();
    const remoteChanges: Resource[] = [];
    this.statusIgnored = [];
    this.isIncomplete = false;
    this.needCleanUp = false;
    const combineExternal = configuration.get<boolean>(
      "sourceControl.combineExternalIfSameServer",
      false
    );

    const fileConfig = workspace.getConfiguration("files", Uri.file(this.root));

    const filesToExclude = fileConfig.get<any>("exclude");

    const excludeList: string[] = [];
    for (const pattern in filesToExclude) {
      if (filesToExclude.hasOwnProperty(pattern)) {
        const negate = !filesToExclude[pattern];
        excludeList.push((negate ? "!" : "") + pattern);
      }
    }

    this.statusExternal = statuses.filter(
      status => status.status === Status.EXTERNAL
    );

    if (combineExternal && this.statusExternal.length) {
      const repositoryUuid = this.repository.info.repository.uuid;
      this.statusExternal = this.statusExternal.filter(
        status => repositoryUuid !== status.repositoryUuid
      );
    }

    const statusesRepository = statuses.filter(status => {
      if (status.status === Status.EXTERNAL) {
        return false;
      }

      return !this.statusExternal.some(external =>
        isDescendant(external.path, status.path)
      );
    });

    const hideUnversioned = configuration.get<boolean>(
      "sourceControl.hideUnversioned"
    );

    const ignoreList = configuration.get<string[]>("sourceControl.ignore");

    for (const status of statusesRepository) {
      if (status.path === ".") {
        this.isIncomplete = status.status === Status.INCOMPLETE;
        this.needCleanUp = status.wcStatus.locked;
      }

      // If exists a switched item, the repository is incomplete
      // To simulate, run "svn switch" and kill "svn" proccess
      // After, run "svn update"
      if (status.wcStatus.switched) {
        this.isIncomplete = true;
      }

      if (
        status.wcStatus.locked ||
        status.wcStatus.switched ||
        status.status === Status.INCOMPLETE
      ) {
        // On commit, `svn status` return all locked files with status="normal" and props="none"
        continue;
      }

      if (matchAll(status.path, excludeList, { dot: true })) {
        continue;
      }

      const uri = Uri.file(path.join(this.workspaceRoot, status.path));
      const renameUri = status.rename
        ? Uri.file(path.join(this.workspaceRoot, status.rename))
        : undefined;

      if (status.reposStatus) {
        const remoteResource = new Resource(
          uri,
          status.reposStatus.item,
          undefined,
          status.reposStatus.props,
          true
        );
        if (preview) this.previewResources.add(remoteResource);
        remoteChanges.push(remoteResource);
      }

      const resource = new Resource(
        uri,
        status.status,
        renameUri,
        status.props
      );
      if (preview) this.previewResources.add(resource);

      if (
        (status.status === Status.NORMAL || status.status === Status.NONE) &&
        (status.props === Status.NORMAL || status.props === Status.NONE) &&
        !status.changelist
      ) {
        // Ignore non changed itens
        continue;
      } else if (status.status === Status.IGNORED) {
        this.statusIgnored.push(status);
      } else if (status.status === Status.CONFLICTED) {
        conflicts.push(resource);
      } else if (status.status === Status.UNVERSIONED) {
        if (hideUnversioned) {
          continue;
        }

        const matches = status.path.match(
          /(.+?)\.(mine|working|merge-\w+\.r\d+|r\d+)$/
        );

        // If file end with (mine, working, merge, etc..) and has file without extension
        if (
          matches &&
          matches[1] &&
          statuses.some(s => s.path === matches[1])
        ) {
          continue;
        }
        if (
          ignoreList.length > 0 &&
          matchAll(path.sep + status.path, ignoreList, {
            dot: true,
            matchBase: true
          })
        ) {
          continue;
        }
        unversioned.push(resource);
      } else if (status.changelist) {
        let changelist = changelists.get(status.changelist);
        if (!changelist) {
          changelist = [];
        }
        changelist.push(resource);
        changelists.set(status.changelist, changelist);
      } else {
        changes.push(resource);
      }
    }

    this.changes.resourceStates = changes;
    this.conflicts.resourceStates = conflicts;

    const prevChangelistsSize = this.changelists.size;

    this.changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });

    const counts = [this.changes, this.conflicts];

    const ignoreOnStatusCountList = configuration.get<string[]>(
      "sourceControl.ignoreOnStatusCount"
    );

    changelists.forEach((resources, changelist) => {
      let group = this.changelists.get(changelist);
      if (!group) {
        // Prefix 'changelist-' to prevent double id with 'change' or 'external'
        group = this.sourceControl.createResourceGroup(
          `changelist-${changelist}`,
          `Changelist "${changelist}"`
        ) as ISvnResourceGroup;
        group.repository = this;
        group.hideWhenEmpty = true;
        this.disposables.push(group);

        this.changelists.set(changelist, group);
      }

      group.resourceStates = resources;

      if (!ignoreOnStatusCountList.includes(changelist)) {
        counts.push(group);
      }
    });

    // Recreate unversioned group to move after changelists
    if (prevChangelistsSize !== this.changelists.size) {
      this.unversioned.dispose();

      this.unversioned = this.sourceControl.createResourceGroup(
        "unversioned",
        "Unversioned"
      ) as ISvnResourceGroup;

      this.unversioned.repository = this;
      this.unversioned.hideWhenEmpty = true;
    }

    this.unversioned.resourceStates = unversioned;

    if (configuration.get<boolean>("sourceControl.countUnversioned", false)) {
      counts.push(this.unversioned);
    }

    this.sourceControl.count = counts.reduce(
      (a, b) => a + b.resourceStates.length,
      0
    );

    // Recreate remoteChanges group to move after unversioned
    if (!this.remoteChanges || prevChangelistsSize !== this.changelists.size) {
      /**
       * Destroy and create for keep at last position
       */
      let tempResourceStates: Resource[] = [];
      if (this.remoteChanges) {
        tempResourceStates = this.remoteChanges.resourceStates;
        this.remoteChanges.dispose();
      }

      this.remoteChanges = this.sourceControl.createResourceGroup(
        "remotechanges",
        "Remote Changes"
      ) as ISvnResourceGroup;

      this.remoteChanges.repository = this;
      this.remoteChanges.hideWhenEmpty = true;
      this.remoteChanges.resourceStates = tempResourceStates;
    }

    // Update remote changes group
    if (checkRemoteChanges) {
      this.remoteChanges.resourceStates = remoteChanges;

      if (remoteChanges.length !== this.remoteChangedFiles) {
        this.remoteChangedFiles = remoteChanges.length;
        this._onDidChangeRemoteChangedFiles.fire();
      }
    }

    this._onDidRebuildStatusProjection.fire();

    if (preview) {
      this.sourceControl.quickDiffProvider = this;
    } else if (publishStatus) {
      this._onDidChangeStatus.fire();
    }
  }

  /** File events remain queued in the normal adapter for eventual reconciliation. */
  public validateStartupFile(absolutePath: string, deleted = false): void {
    if (this.disposed || this.hasLiveStatus || !this.isInitialStatusPending)
      return;
    const relative = path.relative(this.workspaceRoot, absolutePath);
    if (!isSnapshotPath(relative) || relative === ".") return;
    const key = snapshotPathKey(relative);
    if (deleted) this.startupDeletionPending = true;
    this.startupFileVersion++;
    // New evidence is needed after every event, even if an earlier check succeeded.
    for (const cached of this.startupFileResults.keys()) {
      if (cached === key || cached.startsWith(key + path.sep)) {
        this.startupFileResults.delete(cached);
      }
    }
    if (
      !this.startupFilesSeen.has(key) &&
      this.startupFilesSeen.size >= STARTUP_MAX_FILES
    )
      return;
    this.startupFilesSeen.add(key);
    this.startupFileTargets.set(key, relative);
    this.scheduleStartupFileScan();
  }

  @debounce(200)
  private scheduleStartupFileScan(): void {
    void this.scanStartupFiles();
  }

  private async scanStartupFiles(): Promise<void> {
    if (
      this.disposed ||
      this.hasLiveStatus ||
      !this.isInitialStatusPending ||
      !this.startupPreviewReady ||
      this.startupFileScanRunning ||
      !this.startupFileTargets.size
    )
      return;
    this.startupFileScanRunning = true;
    const version = this.startupFileVersion;
    const requested = [...this.startupFileTargets.values()];
    this.startupFileTargets.clear();
    try {
      const identity = await this.getSnapshotIdentity();
      const saved = this.statusSnapshot ?? [];
      const byPath = new Map(saved.map(s => [snapshotPathKey(s.path), s]));
      const candidates = requested.map(file => ({
        ...(byPath.get(snapshotPathKey(file)) ?? {
          path: file,
          props: Status.NONE,
          wcStatus: { locked: false, switched: false }
        }),
        // Even a previously clean path now needs validation.
        status: Status.MODIFIED
      }));
      const targets = await selectStartupTargets(
        this.workspaceRoot,
        [...candidates, ...saved.filter(s => s.status === Status.EXTERNAL)],
        this.repository.usesPerDirectoryMetadata
      );
      if (
        this.disposed ||
        this.hasLiveStatus ||
        !this.isInitialStatusPending ||
        !targets.length
      )
        return;
      const updated = await this.repository.getStartupStatus(
        targets,
        this.startupAbort.signal
      );
      const currentIdentity = await this.getSnapshotIdentity();
      if (
        this.disposed ||
        this.hasLiveStatus ||
        !this.isInitialStatusPending ||
        identity !== currentIdentity
      )
        return;
      if (version !== this.startupFileVersion) {
        for (const target of requested)
          this.startupFileTargets.set(snapshotPathKey(target), target);
        return;
      }
      const merged = mergeStartupStatus(
        this.statusSnapshot ?? [],
        targets,
        updated
      );
      const selected = new Set(targets.map(snapshotPathKey));
      const returned = new Set(updated.map(s => snapshotPathKey(s.path)));
      for (const status of merged) {
        const key = snapshotPathKey(status.path);
        if (selected.has(key) && returned.has(key))
          this.startupFileResults.set(key, status);
      }
      this.applyStatus(merged, false, true);
    } catch (error) {
      if (!this.disposed)
        console.error(
          "Unable to validate file during initial SVN status",
          error
        );
    } finally {
      this.startupFileScanRunning = false;
      if (
        !this.disposed &&
        !this.hasLiveStatus &&
        this.isInitialStatusPending &&
        this.startupFileTargets.size
      )
        this.scheduleStartupFileScan();
    }
  }

  private async getSnapshotIdentity(): Promise<string> {
    const info = this.repository.info;
    return workingCopyIdentity(
      this.root,
      this.workspaceRoot,
      info.repository.uuid,
      info.url,
      getSvnDir()
    );
  }

  private async restoreStartupStatus(): Promise<void> {
    if (!this.snapshotStore || this.disposed) return;
    try {
      const identity = await this.getSnapshotIdentity();
      if (this.disposed) return;
      const saved = this.snapshotStore.read(identity);
      if (!saved) return;
      this.applyStatus(
        saved,
        remoteIntervalSeconds(
          configuration.get("remoteChanges.checkFrequency", 300)
        ) > 0,
        true
      );
      const targets = await selectStartupTargets(
        this.workspaceRoot,
        saved,
        this.repository.usesPerDirectoryMetadata
      );
      if (this.disposed || !targets.length) return;
      const updated = await this.repository.getStartupStatus(
        targets,
        this.startupAbort.signal
      );
      if (this.disposed || identity !== (await this.getSnapshotIdentity()))
        return;
      this.applyStatus(
        mergeStartupStatus(saved, targets, updated),
        remoteIntervalSeconds(
          configuration.get("remoteChanges.checkFrequency", 300)
        ) > 0,
        true
      );
    } catch (error) {
      // Optional acceleration must never prevent the authoritative full scan.
      if (!this.disposed)
        console.error("Unable to restore/validate saved SVN status", error);
    }
  }

  private async persistStatus(statuses: IFileStatus[]): Promise<void> {
    if (!this.snapshotStore || this.disposed) return;
    try {
      const identity = await this.getSnapshotIdentity();
      if (this.disposed) return;
      await this.snapshotStore.write(identity, this.statusSnapshot ?? statuses);
    } catch (error) {
      if (!this.disposed) console.error("Unable to save SVN status", error);
    }
  }

  /** Called before building choices that depend on the complete SCM list. */
  public async ensureStatus(): Promise<void> {
    await this.initialStatusSettled;
    if (this.disposed) throw new Error("Repository disposed");
    if (!this.hasLiveStatus) await this.fullStatus();
    if (!this.hasLiveStatus || this.disposed)
      throw new Error("SVN status is unavailable");
  }

  public isPreviewResource(resource: Resource): boolean {
    return this.previewResources.has(resource);
  }

  public getResourceFromFile(uri: string | Uri): Resource | undefined {
    if (typeof uri === "string") {
      uri = Uri.file(uri);
    }

    const groups = [
      this.changes,
      this.conflicts,
      this.unversioned,
      ...(this.staged ? [this.staged] : []),
      ...this.changelists.values()
    ];

    const uriString = uri.toString();

    for (const group of groups) {
      for (const resource of group.resourceStates) {
        if (
          uriString === resource.resourceUri.toString() &&
          resource instanceof Resource
        ) {
          return resource;
        }
      }
    }

    return undefined;
  }

  public provideOriginalResource(uri: Uri): Uri | undefined {
    if (uri.scheme !== "file") {
      return;
    }

    const resource = this.getResourceFromFile(uri);
    if (resource && resource.type === Status.UNVERSIONED) {
      return;
    }

    // Not has original resource for content of ".svn" folder
    if (isDescendant(path.join(this.root, getSvnDir()), uri.fsPath)) {
      return;
    }

    return toSvnUri(uri, SvnUriAction.SHOW, {}, true);
  }

  public async status() {
    await this.initialStatusSettled;
    if (this.disposed) {
      return;
    }

    return this.run(Operation.Status);
  }

  @throttle
  public async fullStatus() {
    if (!(await this.whenIdle())) {
      return;
    }

    return this.run(Operation.Status, undefined, true);
  }

  public async show(
    filePath: string | Uri,
    revision?: string
  ): Promise<string> {
    return this.run<string>(Operation.Show, () => {
      return this.repository.show(filePath, revision);
    });
  }

  public async showBuffer(
    filePath: string | Uri,
    revision?: string
  ): Promise<Buffer> {
    return this.run<Buffer>(Operation.Show, () => {
      return this.repository.showBuffer(filePath, revision);
    });
  }

  public async addFiles(files: string[]) {
    return this.run(Operation.Add, () => this.repository.addFiles(files));
  }

  public async addChangelist(files: string[], changelist: string) {
    return this.run(Operation.AddChangelist, () =>
      this.repository.addChangelist(files, changelist)
    );
  }

  public async removeChangelist(files: string[]) {
    return this.run(Operation.RemoveChangelist, () =>
      this.repository.removeChangelist(files)
    );
  }

  public async getCurrentBranch() {
    return this.run(Operation.CurrentBranch, async () => {
      return this.repository.getCurrentBranch();
    });
  }

  public async newBranch(
    name: string,
    commitMessage: string = "Created new branch"
  ) {
    return this.run(Operation.NewBranch, async () => {
      await this.repository.newBranch(name, commitMessage);
      this.updateRemoteChangedFiles();
    });
  }

  public async switchBranch(name: string, force: boolean = false) {
    await this.run(Operation.SwitchBranch, async () => {
      await this.repository.switchBranch(name, force);
      this.updateRemoteChangedFiles();
    });
  }

  public async merge(
    name: string,
    reintegrate: boolean = false,
    accept_action: string = "postpone"
  ) {
    await this.run(Operation.Merge, async () => {
      await this.repository.merge(name, reintegrate, accept_action);
      this.updateRemoteChangedFiles();
    });
  }

  public async updateRevision(
    ignoreExternals: boolean = false
  ): Promise<string> {
    return this.run<string>(Operation.Update, async () => {
      const response = await this.repository.update(ignoreExternals);
      this.updateRemoteChangedFiles();
      return response;
    });
  }

  public async pullIncomingChange(path: string) {
    return this.run<string>(Operation.Update, async () => {
      const response = await this.repository.pullIncomingChange(path);
      this.updateRemoteChangedFiles();
      return response;
    });
  }

  public async resolve(files: string[], action: string) {
    return this.run(Operation.Resolve, () =>
      this.repository.resolve(files, action)
    );
  }

  public async commitFiles(message: string, files: any[]) {
    return this.run(Operation.Commit, () =>
      this.repository.commitFiles(message, files)
    );
  }

  public async revert(files: string[], depth: keyof typeof SvnDepth) {
    return this.run(Operation.Revert, () =>
      this.repository.revert(files, depth)
    );
  }

  public async info(path: string) {
    return this.run(Operation.Info, () => this.repository.getInfo(path));
  }

  public async patch(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patch(files));
  }

  public async patchBuffer(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patchBuffer(files));
  }

  public async patchChangelist(changelistName: string) {
    return this.run(Operation.Patch, () =>
      this.repository.patchChangelist(changelistName)
    );
  }

  public async removeFiles(files: string[], keepLocal: boolean) {
    return this.run(Operation.Remove, () =>
      this.repository.removeFiles(files, keepLocal)
    );
  }

  public async plainLog() {
    return this.run(Operation.Log, () => this.repository.plainLog());
  }

  public async plainLogBuffer() {
    return this.run(Operation.Log, () => this.repository.plainLogBuffer());
  }

  public async plainLogByRevision(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevision(revision)
    );
  }

  public async plainLogByRevisionBuffer(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevisionBuffer(revision)
    );
  }

  public async plainLogByText(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByText(search)
    );
  }

  /** Each auth retry starts a new snapshot; cancellation owns all attempts. */
  public async searchLogByText(
    search: string,
    signal: AbortSignal,
    onContent: (content: string) => void
  ): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const disposal = this.onDidDispose(cancel);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted || this.disposed) {
      cancel();
    }
    try {
      if (controller.signal.aborted) {
        throw new SvnCancellationError();
      }
      await this.run(
        Operation.Log,
        async () => {
          if (controller.signal.aborted) {
            throw new SvnCancellationError();
          }
          let content = "";
          onContent(content);
          await this.repository.plainLogByText(search, {
            signal: controller.signal,
            onStdout: chunk => {
              content += chunk;
              onContent(content);
            }
          });
        },
        false,
        controller.signal
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      disposal.dispose();
    }
  }

  public async plainLogByTextBuffer(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByTextBuffer(search)
    );
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri
  ) {
    return this.run(Operation.Log, () =>
      this.repository.log(rfrom, rto, limit, target)
    );
  }

  public async logByUser(user: string) {
    return this.run(Operation.Log, () => this.repository.logByUser(user));
  }

  public async cleanup() {
    return this.run(
      Operation.CleanUp,
      () => this.repository.cleanup(),
      false,
      undefined,
      true
    );
  }

  public async removeUnversioned() {
    return this.run(Operation.CleanUp, () =>
      this.repository.removeUnversioned()
    );
  }

  public async getInfo(path: string, revision?: string): Promise<ISvnInfo> {
    return this.run(Operation.Info, () =>
      this.repository.getInfo(path, revision, true)
    );
  }

  public async getChanges(): Promise<ISvnPathChange[]> {
    return this.run(Operation.Changes, () => this.repository.getChanges());
  }

  public async finishCheckout() {
    return this.run(Operation.SwitchBranch, () =>
      this.repository.finishCheckout()
    );
  }

  public async addToIgnore(
    expressions: string[],
    directory: string,
    recursive: boolean = false
  ) {
    return this.run(Operation.Ignore, () =>
      this.repository.addToIgnore(expressions, directory, recursive)
    );
  }

  public async rename(oldFile: string, newFile: string) {
    return this.run(Operation.Rename, () =>
      this.repository.rename(oldFile, newFile)
    );
  }

  public async list(filePath: string): Promise<ISvnListItem[]> {
    return this.run<ISvnListItem[]>(Operation.List, () => {
      return this.repository.ls(filePath);
    });
  }

  public getPathNormalizer(): PathNormalizer {
    return new PathNormalizer(this.repository.info);
  }

  protected getCredentialServiceName() {
    let key = "vscode.svn-scm";

    const info = this.repository.info;

    if (info.repository && info.repository.root) {
      key += ":" + info.repository.root;
    } else if (info.url) {
      key += ":" + info.url;
    }

    return key;
  }

  public async loadStoredAuths(
    signal?: AbortSignal
  ): Promise<Array<IStoredAuth>> {
    // Prevent multiple prompts for auth
    if (this.lastPromptAuth) {
      try {
        await waitForSvn(this.lastPromptAuth, signal);
      } catch (error) {
        // An independently cancelled prompt must not cancel this operation.
        if (!(error instanceof SvnCancellationError) || signal?.aborted) {
          throw error;
        }
      }
    }

    if (signal?.aborted) {
      throw new SvnCancellationError();
    }
    const secret = await waitForSvn(
      this.secrets.get(this.getCredentialServiceName()),
      signal
    );

    if (typeof secret === "undefined") {
      return [];
    }

    const credentials = JSON.parse(secret) as Array<IStoredAuth>;

    return credentials;
  }

  public async saveAuth(): Promise<void> {
    if (this.canSaveAuth && this.username && this.password) {
      const secret = await this.secrets.get(this.getCredentialServiceName());
      let credentials: Array<IStoredAuth> = [];

      if (typeof secret === "string") {
        credentials = JSON.parse(secret) as Array<IStoredAuth>;
      }

      credentials.push({
        account: this.username,
        password: this.password
      });

      await this.secrets.store(
        this.getCredentialServiceName(),
        JSON.stringify(credentials)
      );

      this.canSaveAuth = false;
    }
  }

  public async promptAuth(signal?: AbortSignal): Promise<IAuth | undefined> {
    if (signal?.aborted) {
      throw new SvnCancellationError();
    }
    // Prevent multiple prompts for auth
    if (this.lastPromptAuth) {
      try {
        return await waitForSvn(this.lastPromptAuth, signal);
      } catch (error) {
        if (error instanceof SvnCancellationError && !signal?.aborted) {
          return this.promptAuth(signal);
        }
        throw error;
      }
    }

    const cancellation = new CancellationTokenSource();
    const request = (async () => {
      const result = await waitForSvn(
        commands.executeCommand<IAuth>(
          "svn.promptAuth",
          undefined,
          undefined,
          cancellation.token
        ),
        signal
      );
      if (signal?.aborted) {
        throw new SvnCancellationError();
      }
      if (result) {
        this.username = result.username;
        this.password = result.password;
        this.canSaveAuth = true;
      }
      return result;
    })();
    this.lastPromptAuth = request;
    const cancel = () => {
      cancellation.cancel();
      if (this.lastPromptAuth === request) {
        this.lastPromptAuth = undefined;
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
    }
    try {
      return await request;
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancellation.dispose();
      if (this.lastPromptAuth === request) {
        this.lastPromptAuth = undefined;
      }
    }
  }

  public onDidSaveTextDocument(document: TextDocument) {
    if (!this.hasLiveStatus || this.disposed) return;
    const uriString = document.uri.toString();
    const conflict = this.conflicts.resourceStates.find(
      resource => resource.resourceUri.toString() === uriString
    );
    if (!conflict) {
      return;
    }

    const text = document.getText();

    // Check for lines begin with "<<<<<<", "=======", ">>>>>>>"
    if (!/^<{7}[^]+^={7}[^]+^>{7}/m.test(text)) {
      commands.executeCommand("svn.resolved", conflict.resourceUri);
    }
  }

  private async run<T>(
    operation: Operation,
    runOperation: () => Promise<T> = () => Promise.resolve<any>(null),
    forceFullStatus: boolean = false,
    signal?: AbortSignal,
    allowStatusRecovery = false
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      if (this.disposed || this.state !== RepositoryState.Idle) {
        throw new Error("Repository not initialized");
      }

      if (
        !isReadOnly(operation) &&
        operation !== Operation.Status &&
        operation !== Operation.StatusRemote
      ) {
        if (operation === Operation.CleanUp && allowStatusRecovery) {
          // Recovery must remain available when status itself cannot succeed.
          // Let startup settle first so cleanup never races its status subprocess.
          await this.initialStatusSettled;
        } else {
          await this.ensureStatus();
        }
      }
      if (this.disposed) throw new Error("Repository disposed");

      const run = async () => {
        this._operations.start(operation);
        this._onRunOperation.fire(operation);

        try {
          const result = await this.retryRun(runOperation, signal);

          const checkRemote = operation === Operation.StatusRemote;

          if (!isReadOnly(operation)) {
            if (forceFullStatus) {
              await this.updateModelStateSequential(checkRemote, true);
            } else {
              await this.updateModelState(checkRemote);
            }
          }

          return result;
        } catch (err) {
          if (
            err instanceof SvnError &&
            err.svnErrorCode === svnErrorCodes.NotASvnRepository
          ) {
            this.state = RepositoryState.Disposed;
          }

          const rootExists = await exists(this.workspaceRoot);
          if (!rootExists) {
            await commands.executeCommand("svn.close", this);
          }

          throw err;
        } finally {
          this._operations.end(operation);
          this._onDidRunOperation.fire(operation);
        }
      };

      return shouldShowProgress(operation)
        ? window.withProgress({ location: ProgressLocation.SourceControl }, run)
        : run();
    };

    const locksWorkingCopy =
      !isReadOnly(operation) &&
      operation !== Operation.Status &&
      operation !== Operation.StatusRemote;

    return locksWorkingCopy
      ? withWorkingCopyMutationLock(this.root, execute)
      : execute();
  }

  private async retryRun<T>(
    runOperation: () => Promise<T> = () => Promise.resolve<any>(null),
    signal?: AbortSignal
  ): Promise<T> {
    let attempt = 0;
    let accounts: IStoredAuth[] = [];

    while (true) {
      if (signal?.aborted) {
        throw new SvnCancellationError();
      }
      try {
        attempt++;
        const result = await runOperation();
        this.saveAuth();
        return result;
      } catch (err) {
        if (signal?.aborted) {
          throw new SvnCancellationError();
        }
        if (
          err instanceof SvnError &&
          err.svnErrorCode === svnErrorCodes.RepositoryIsLocked &&
          attempt <= 10
        ) {
          // quatratic backoff
          await timeout(Math.pow(attempt, 2) * 50);
        } else if (
          err instanceof SvnError &&
          err.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
          attempt <= 1 + accounts.length
        ) {
          // First attempt load all stored auths
          if (attempt === 1) {
            accounts = await this.loadStoredAuths(signal);
          }

          if (signal?.aborted) {
            throw new SvnCancellationError();
          }

          // each attempt, try a different account
          const index = accounts.length - 1;
          if (typeof accounts[index] !== "undefined") {
            this.username = accounts[index].account;
            this.password = accounts[index].password;
          }
        } else if (
          err instanceof SvnError &&
          err.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
          attempt <= 3 + accounts.length
        ) {
          const result = await this.promptAuth(signal);
          if (!result) {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.startupAbort?.abort();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidRebuildStatusProjection?.dispose();
    cancelDebounces(this);
    this.disposables = dispose(this.disposables);
  }
}
