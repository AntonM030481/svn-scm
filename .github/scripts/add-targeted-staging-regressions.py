from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{label} not found in {path}")
    p.write_text(text.replace(old, new, 1))


# Integration regression: an external changelist removal with autorefresh off
# must not leave svn.commit routed through stale staged metadata.
path = "src/test/staging.test.ts"
marker = '''  test("hidden staged files remain available to unstage all and commit staged", async () => {\n'''
test = '''  test("palette commit refreshes staging membership after external unstage", async () => {\n    const checkout = await createCheckoutWithFiles();\n    await sourceControlManager.tryOpenRepository(checkout.fsPath);\n    const repository = sourceControlManager.getRepository(\n      checkout\n    ) as Repository;\n    opened.push(repository);\n\n    const file = path.join(checkout.fsPath, "one", "a.txt");\n    fs.writeFileSync(file, "external-unstage edit\\n");\n    await repository.status();\n    const resource = repository.changes.resourceStates.find(\n      item => item.resourceUri.fsPath === file\n    );\n    assert.ok(resource);\n    await commands.executeCommand("svn.stage", resource);\n\n    await window.showTextDocument(Uri.file(file));\n    const svnConfiguration = workspace.getConfiguration("svn");\n    const previousAutorefresh =\n      svnConfiguration.inspect<boolean>("autorefresh")?.globalValue;\n\n    try {\n      await svnConfiguration.update(\n        "autorefresh",\n        false,\n        ConfigurationTarget.Global\n      );\n      svn(["changelist", "--remove", file], checkout.fsPath);\n      assert.doesNotMatch(\n        svn(["status", "--xml"], checkout.fsPath),\n        /__svn_scm_staged__/\n      );\n\n      repository.inputBox.value = "commit after external unstage";\n      await commands.executeCommand("svn.commit");\n      assert.equal(svn(["status"], checkout.fsPath).trim(), "");\n    } finally {\n      await svnConfiguration.update(\n        "autorefresh",\n        previousAutorefresh,\n        ConfigurationTarget.Global\n      );\n      await commands.executeCommand("workbench.action.closeActiveEditor");\n    }\n  });\n\n'''
replace_once(path, marker, test + marker, "stale commit membership test insertion")

# Unit-style fixture coverage for explicit + watcher targets and idle ordering.
path = "src/test/incrementalStatus.test.ts"
old = '''import { Disposable, EventEmitter } from "vscode";\n'''
new = '''import { Disposable, EventEmitter, Uri } from "vscode";\n'''
replace_once(path, old, new, "incremental test Uri import")

old = '''  fileSnapshotsEqual,\n  enableIncrementalStatusRefresh,\n'''
new = '''  fileSnapshotsEqual,\n  enableIncrementalStatusRefresh,\n  refreshStatusTargets,\n'''
replace_once(path, old, new, "refreshStatusTargets import")

old = '''  const events: string[] = [];\n  const notifiedRevisions: string[] = [];\n'''
new = '''  const events: string[] = [];\n  const notifiedRevisions: string[] = [];\n  const targetedStatusArgs: string[][] = [];\n  const workspaceChange = new EventEmitter<Uri>();\n  const workspaceCreate = new EventEmitter<Uri>();\n  const workspaceDelete = new EventEmitter<Uri>();\n  const svnAny = new EventEmitter<Uri>();\n'''
replace_once(path, old, new, "fixture event emitters")

old = '''    events.push("targeted-status");\n    return { exitCode: 0, stderr: "", stdout: "<status></status>" };\n'''
new = '''    events.push("targeted-status");\n    targetedStatusArgs.push([...args]);\n    return { exitCode: 0, stderr: "", stdout: "<status></status>" };\n'''
replace_once(path, old, new, "targeted status args capture")

old = '''    onDidAnyFileChanged() {},\n    eventuallyUpdateWhenIdleAndWait() {},\n    updateWhenIdleAndWait() {},\n    status() {},\n    fsWatcher: {\n      onDidWorkspaceChange: subscribe,\n      onDidWorkspaceCreate: subscribe,\n      onDidWorkspaceDelete: subscribe,\n      onDidSvnAny: subscribe\n    },\n'''
new = '''    onDidAnyFileChanged() {},\n    eventuallyUpdateWhenIdleAndWait() {},\n    updateWhenIdleAndWait() {},\n    whenIdle: async () => true,\n    status: async () => {\n      await svnRepository.getStatus({\n        includeIgnored: true,\n        includeExternals: false\n      });\n    },\n    fsWatcher: {\n      onDidWorkspaceChange: workspaceChange.event,\n      onDidWorkspaceCreate: workspaceCreate.event,\n      onDidWorkspaceDelete: workspaceDelete.event,\n      onDidSvnAny: svnAny.event\n    },\n'''
replace_once(path, old, new, "fixture status and watcher events")

old = '''    events,\n    notifiedRevisions,\n    dispose: () => {\n'''
new = '''    events,\n    notifiedRevisions,\n    targetedStatusArgs,\n    emitWorkspaceChange: (file: string) => workspaceChange.fire(Uri.file(file)),\n    dispose: () => {\n'''
replace_once(path, old, new, "fixture return helpers")

marker = '''  test("replaces only the targeted file", () => {\n'''
tests = '''  test("keeps explicit targets when watcher work is already queued", async () => {\n    const fixture = await mutationFixture("/repo");\n    try {\n      fixture.emitWorkspaceChange("/repo/watcher.ts");\n      await new Promise(resolve => setTimeout(resolve, 20));\n      fixture.events.length = 0;\n      fixture.targetedStatusArgs.length = 0;\n\n      await refreshStatusTargets(fixture.repository, ["/repo/explicit.ts"]);\n\n      assert.equal(fixture.targetedStatusArgs.length, 1);\n      const args = fixture.targetedStatusArgs[0];\n      assert.ok(args.some(arg => /explicit\\.ts$/.test(arg)));\n      assert.ok(args.some(arg => /watcher\\.ts$/.test(arg)));\n      assert.equal(fixture.events.includes("full-status"), false);\n    } finally {\n      fixture.dispose();\n    }\n  });\n\n  test("targeted refresh waits for idle before starting status", async () => {\n    const fixture = await mutationFixture("/repo");\n    let releaseIdle!: () => void;\n    const idleGate = new Promise<void>(resolve => {\n      releaseIdle = resolve;\n    });\n    const order: string[] = [];\n    (fixture.repository as any).whenIdle = async () => {\n      order.push("wait-idle");\n      await idleGate;\n      return true;\n    };\n    const status = (fixture.repository as any).status.bind(fixture.repository);\n    (fixture.repository as any).status = async () => {\n      order.push("status");\n      return status();\n    };\n\n    try {\n      const refresh = refreshStatusTargets(fixture.repository, [\n        "/repo/explicit.ts"\n      ]);\n      await Promise.resolve();\n      assert.deepEqual(order, ["wait-idle"]);\n      releaseIdle();\n      await refresh;\n      assert.deepEqual(order, ["wait-idle", "status"]);\n      assert.equal(fixture.events.includes("targeted-status"), true);\n    } finally {\n      fixture.dispose();\n    }\n  });\n\n'''
replace_once(path, marker, tests + marker, "incremental targeted regression insertion")
