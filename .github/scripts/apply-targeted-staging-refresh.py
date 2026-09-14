from pathlib import Path

p = Path('src/incrementalStatus.ts')
s = p.read_text()
old = '''const workingCopyMutations = new Map<string, WorkingCopyMutationState>();
'''
new = '''const workingCopyMutations = new Map<string, WorkingCopyMutationState>();
const incrementalStatusStates = new WeakMap<Repository, IncrementalStatusState>();
'''
if old not in s:
    raise SystemExit('incremental state insertion point not found')
s = s.replace(old, new, 1)

old = '''  const state: IncrementalStatusState = {
    statuses: snapshotStatuses(repository),
    expectedFsEchoes: new Map<string, ExpectedFsEcho>(),
    fsTargets: new Set<string>(),
    svnRefreshPending: false
  };
'''
new = '''  const state: IncrementalStatusState = {
    statuses: snapshotStatuses(repository),
    expectedFsEchoes: new Map<string, ExpectedFsEcho>(),
    fsTargets: new Set<string>(),
    svnRefreshPending: false
  };
  incrementalStatusStates.set(repository, state);
'''
if old not in s:
    raise SystemExit('state creation block not found')
s = s.replace(old, new, 1)

old = '''  return toDisposable(() => {
    svnRepository.getStatus = originalGetStatus;
'''
new = '''  return toDisposable(() => {
    incrementalStatusStates.delete(repository);
    svnRepository.getStatus = originalGetStatus;
'''
if old not in s:
    raise SystemExit('dispose block not found')
s = s.replace(old, new, 1)

marker = '''export function enableIncrementalStatusRefresh(
'''
helper = '''export async function refreshStatusTargets(
  repository: Repository,
  targets: string[]
): Promise<void> {
  const state = incrementalStatusStates.get(repository);
  const scopedTargets = operationTargets(repository, targets);
  if (!state || !scopedTargets?.length) {
    await repository.fullStatus();
    return;
  }

  state.statuses = snapshotStatuses(repository);
  state.pendingTargets = scopedTargets;
  state.repositoryState = getRepositoryStateForTargets(
    repository,
    scopedTargets
  );

  try {
    await repository.status();
  } finally {
    state.pendingTargets = undefined;
    state.repositoryState = undefined;
  }
}

'''
if marker not in s:
    raise SystemExit('export marker not found')
s = s.replace(marker, helper + marker, 1)
p.write_text(s)

p = Path('src/stagingCoordinator.ts')
s = p.read_text()
old = '''import { lstat } from "./fs";
'''
new = '''import { lstat } from "./fs";
import { refreshStatusTargets } from "./incrementalStatus";
'''
if old not in s:
    raise SystemExit('staging import point not found')
s = s.replace(old, new, 1)

old = '''    const validated: Resource[] = [];
    for (const [repository, selected] of byRepository) {
      await repository.fullStatus();
      const staged = this.states.get(repository)?.group.resourceStates ?? [];
'''
new = '''    const validated: Resource[] = [];
    for (const [repository, selected] of byRepository) {
      await refreshStatusTargets(
        repository,
        selected.map(resource => resource.resourceUri.fsPath)
      );
      const staged = this.states.get(repository)?.group.resourceStates ?? [];
'''
if old not in s:
    raise SystemExit('validation fullStatus block not found')
s = s.replace(old, new, 1)

old = '''  private async refreshProjectionsContainingPaths(
    repository: Repository,
    resources: Resource[]
  ): Promise<void> {
    const filePaths = resources.map(resource => resource.resourceUri.fsPath);
    const peers = this.repositoriesForWorkingCopy(repository).filter(peer =>
      filePaths.some(filePath => isPathInside(peer.workspaceRoot, filePath))
    );
    await Promise.all(peers.map(peer => peer.fullStatus()));
  }
'''
new = '''  private async refreshProjectionsContainingPaths(
    repository: Repository,
    resources: Resource[]
  ): Promise<void> {
    const filePaths = resources.map(resource => resource.resourceUri.fsPath);
    const peers = this.repositoriesForWorkingCopy(repository).filter(
      peer =>
        peer !== repository &&
        filePaths.some(filePath => isPathInside(peer.workspaceRoot, filePath))
    );
    await Promise.all(
      peers.map(peer =>
        refreshStatusTargets(
          peer,
          filePaths.filter(filePath => isPathInside(peer.workspaceRoot, filePath))
        )
      )
    );
  }
'''
if old not in s:
    raise SystemExit('projection refresh block not found')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('src/test/stagingUiArgs.test.ts')
s = p.read_text()
old = '''    // SCM tree view uses an IResourceNode wrapper as the inline action context.
    // The actual SourceControlResourceState is stored in `element`.
    const treeResourceNode = { element: resource };

    await commands.executeCommand("svn.stage", treeResourceNode);
'''
new = '''    // SCM tree view uses an IResourceNode wrapper as the inline action context.
    // The actual SourceControlResourceState is stored in `element`.
    const treeResourceNode = { element: resource };
    const originalFullStatus = repository.fullStatus.bind(repository);
    let fullStatusCalls = 0;
    repository.fullStatus = async () => {
      fullStatusCalls += 1;
      return originalFullStatus();
    };

    await commands.executeCommand("svn.stage", treeResourceNode);
'''
if old not in s:
    raise SystemExit('UI stage test insertion point not found')
s = s.replace(old, new, 1)

old = '''    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
  });

  test("Stage accepts an unversioned SCM tree resource-node argument", async () => {
'''
new = '''    assert.equal(
      repository.changes.resourceStates.some(
        item => item.resourceUri.fsPath === file
      ),
      true
    );
    assert.equal(fullStatusCalls, 0);
  });

  test("Stage accepts an unversioned SCM tree resource-node argument", async () => {
'''
if old not in s:
    raise SystemExit('UI stage test assertion point not found')
s = s.replace(old, new, 1)
p.write_text(s)
