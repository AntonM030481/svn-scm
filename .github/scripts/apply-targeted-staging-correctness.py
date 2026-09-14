from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{label} not found in {path}")
    p.write_text(text.replace(old, new, 1))


# 1. Unversioned unstage: use the authoritative in-memory raw snapshot that the
# preceding targeted remove-changelist refresh has just updated. Do not perform
# another forceFull status scan merely to find ADDED paths/ancestors.
path = "src/stagingCoordinator.ts"
marker = '''  private async addedAncestorDirectoriesForUnstage(\n'''
helper = '''  private snapshotAddedPaths(repository: Repository): string[] {\n    return (repository.getStatusSnapshot() ?? [])\n      .filter(status => status.status === Status.ADDED)\n      .map(status =>\n        path.isAbsolute(status.path)\n          ? status.path\n          : path.resolve(repository.workspaceRoot, status.path)\n      );\n  }\n\n'''
replace_once(path, marker, helper + marker, "snapshotAddedPaths insertion")

old = '''    const selected = new Set(paths.map(normalizePath));\n    const statuses = await repository.repository.getStatus({\n      includeIgnored: true,\n      includeExternals: false,\n      forceFull: true\n    });\n    const added = statuses\n      .filter(status => status.status === Status.ADDED)\n      .map(status =>\n        path.isAbsolute(status.path)\n          ? status.path\n          : path.resolve(repository.workspaceRoot, status.path)\n      )\n      .filter(candidate => isPathInside(createdDirectoryRoot, candidate))\n      .map(normalizePath);\n'''
new = '''    const selected = new Set(paths.map(normalizePath));\n    const added = this.snapshotAddedPaths(repository)\n      .filter(candidate => isPathInside(createdDirectoryRoot, candidate))\n      .map(normalizePath);\n'''
replace_once(path, old, new, "added ancestor full-status removal")

old = '''    const selected = new Set(paths.map(normalizePath));\n    const statuses = await repository.repository.getStatus({\n      includeIgnored: true,\n      includeExternals: false,\n      forceFull: true\n    });\n    const addedPaths = statuses\n      .filter(status => status.status === Status.ADDED)\n      .map(status =>\n        path.isAbsolute(status.path)\n          ? status.path\n          : path.resolve(repository.workspaceRoot, status.path)\n      )\n      .filter(candidate => selected.has(normalizePath(candidate)));\n'''
new = '''    const selected = new Set(paths.map(normalizePath));\n    const addedPaths = this.snapshotAddedPaths(repository).filter(candidate =>\n      selected.has(normalizePath(candidate))\n    );\n'''
replace_once(path, old, new, "unversioned restore full-status removal")

# 2. Give targeted validation the same idle-before-read guarantee that
# fullStatus used to provide, without forcing a root scan.
path = "src/repository.ts"
old = '''  @throttle\n  public async fullStatus() {\n    while (!this.operations.isIdle() && !this.disposed) {\n      const operationFinished = await this.waitForEventOrDispose(\n        this.onDidRunOperation\n      );\n\n      if (!operationFinished) {\n        return;\n      }\n    }\n\n    if (this.disposed) {\n      return;\n    }\n\n    return this.run(Operation.Status, undefined, true);\n  }\n'''
new = '''  @throttle\n  public async fullStatus() {\n    if (!(await this.whenIdle())) {\n      return;\n    }\n\n    return this.run(Operation.Status, undefined, true);\n  }\n'''
replace_once(path, old, new, "fullStatus idle extraction")

old = '''  public async whenIdleAndFocused(): Promise<boolean> {\n    while (!this.disposed) {\n      if (!this.operations.isIdle()) {\n        if (!(await this.waitForEventOrDispose(this.onDidRunOperation))) {\n          return false;\n        }\n        continue;\n      }\n\n      if (!window.state.focused) {\n'''
new = '''  public async whenIdle(): Promise<boolean> {\n    while (!this.disposed && !this.operations.isIdle()) {\n      if (!(await this.waitForEventOrDispose(this.onDidRunOperation))) {\n        return false;\n      }\n    }\n\n    return !this.disposed;\n  }\n\n  public async whenIdleAndFocused(): Promise<boolean> {\n    while (!this.disposed) {\n      if (!(await this.whenIdle())) {\n        return false;\n      }\n\n      if (!window.state.focused) {\n'''
replace_once(path, old, new, "whenIdle insertion")

# 3. Explicit Stage/Unstage targets must survive already queued watcher work.
path = "src/incrementalStatus.ts"
marker = '''function patchRepository(repository: Repository): Disposable {\n'''
helper = '''function mergeStatusTargets(\n  repository: Repository,\n  targets: string[]\n): string[] {\n  const unique = new Map<string, string>();\n  for (const target of targets) {\n    if (!isTargetInWorkspace(repository.workspaceRoot, target)) continue;\n    unique.set(\n      absolutePathKey(repository.workspaceRoot, target),\n      target\n    );\n  }\n  return [...unique.values()];\n}\n\n'''
replace_once(path, marker, helper + marker, "mergeStatusTargets insertion")

old = '''    } else if (state.fsTargets.size) {\n      state.statuses = snapshotStatuses(repository);\n      state.pendingTargets = Array.from(state.fsTargets);\n      state.repositoryState = getRepositoryStateForTargets(\n        repository,\n        state.pendingTargets\n      );\n      state.fsTargets.clear();\n    }\n'''
new = '''    } else if (state.fsTargets.size) {\n      state.statuses = snapshotStatuses(repository);\n      state.pendingTargets = mergeStatusTargets(repository, [\n        ...(state.pendingTargets ?? []),\n        ...state.fsTargets\n      ]);\n      state.repositoryState = getRepositoryStateForTargets(\n        repository,\n        state.pendingTargets\n      );\n      state.fsTargets.clear();\n    }\n'''
replace_once(path, old, new, "queued watcher target merge")

old = '''  state.statuses = snapshotStatuses(repository);\n  state.pendingTargets = scopedTargets;\n'''
new = '''  if (!(await repository.whenIdle())) {\n    return;\n  }\n\n  state.statuses = snapshotStatuses(repository);\n  state.pendingTargets = scopedTargets;\n'''
replace_once(path, old, new, "targeted validation idle wait")

# 4. Palette/resource commit routing must refresh membership before deciding
# whether to delegate to Commit Staged.
path = "src/commands/commit.ts"
old = '''import { inputCommitMessage } from "../messages";\n'''
new = '''import { refreshStatusTargets } from "../incrementalStatus";\nimport { inputCommitMessage } from "../messages";\n'''
replace_once(path, old, new, "commit targeted refresh import")

old = '''      const stagedPaths = new Set(\n'''
new = '''      await refreshStatusTargets(\n        repository,\n        resources.map(resource => resource.fsPath)\n      );\n\n      const stagedPaths = new Set(\n'''
replace_once(path, old, new, "commit membership refresh")

# 5. Regression: ordinary unversioned Stage + Unstage must stay fully targeted.
path = "src/test/stagingUiArgs.test.ts"
p = Path(path)
text = p.read_text()
old = '''    const resource = repository.unversioned.resourceStates.find(\n      item => item.resourceUri.fsPath === file\n    );\n    assert.ok(resource);\n\n    await commands.executeCommand("svn.stage", { element: resource });\n\n    assert.equal(\n      repository.staged?.resourceStates.some(\n        item => item.resourceUri.fsPath === file\n      ),\n      true\n    );\n    assert.match(svn(["status"], checkout.fsPath), /^A\\s+new\\.txt$/m);\n    assert.match(\n      svn(["status", "--xml"], checkout.fsPath),\n      /__svn_scm_staged__/\n    );\n  });\n\n  test("Commit Staged includes hidden added parent directories", async () => {\n'''
new = '''    const resource = repository.unversioned.resourceStates.find(\n      item => item.resourceUri.fsPath === file\n    );\n    assert.ok(resource);\n\n    const originalFullStatus = repository.fullStatus.bind(repository);\n    let fullStatusCalls = 0;\n    repository.fullStatus = async () => {\n      fullStatusCalls += 1;\n      return originalFullStatus();\n    };\n\n    await commands.executeCommand("svn.stage", { element: resource });\n\n    assert.equal(\n      repository.staged?.resourceStates.some(\n        item => item.resourceUri.fsPath === file\n      ),\n      true\n    );\n    assert.match(svn(["status"], checkout.fsPath), /^A\\s+new\\.txt$/m);\n    assert.match(\n      svn(["status", "--xml"], checkout.fsPath),\n      /__svn_scm_staged__/\n    );\n\n    const stagedResource = repository.staged?.resourceStates.find(\n      item => item.resourceUri.fsPath === file\n    );\n    assert.ok(stagedResource);\n    await commands.executeCommand("svn.unstage", { element: stagedResource });\n\n    assert.equal(\n      repository.unversioned.resourceStates.some(\n        item => item.resourceUri.fsPath === file\n      ),\n      true\n    );\n    assert.match(svn(["status"], checkout.fsPath), /^\\?\\s+new\\.txt$/m);\n    assert.equal(fullStatusCalls, 0);\n  });\n\n  test("Commit Staged includes hidden added parent directories", async () => {\n'''
if old not in text:
    raise SystemExit("unversioned staging regression block not found")
p.write_text(text.replace(old, new, 1))
