from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{label} not found in {path}")
    p.write_text(text.replace(old, new, 1))

# Repository owns all long-lived SCM groups. Create Staged Changes first because
# VS Code renders source-control groups in creation order.
path = 'src/repository.ts'
old = '''    this.changes = this.sourceControl.createResourceGroup(\n      "changes",\n      "Changes"\n    ) as ISvnResourceGroup;\n'''
new = '''    // VS Code renders SCM resource groups in creation order. Keep the Git-like\n    // staging group above Changes by creating it first; StagingCoordinator only\n    // owns its contents and staging metadata, not the group's lifetime.\n    this.staged = this.sourceControl.createResourceGroup(\n      "staged",\n      "Staged Changes"\n    ) as ISvnResourceGroup;\n    this.changes = this.sourceControl.createResourceGroup(\n      "changes",\n      "Changes"\n    ) as ISvnResourceGroup;\n'''
replace_once(path, old, new, 'repository staged group creation')

old = '''    this.changes.repository = this;\n    this.conflicts.repository = this;\n    this.unversioned.repository = this;\n    this.changes.hideWhenEmpty = true;\n'''
new = '''    this.staged.repository = this;\n    this.changes.repository = this;\n    this.conflicts.repository = this;\n    this.unversioned.repository = this;\n    this.staged.hideWhenEmpty = true;\n    this.changes.hideWhenEmpty = true;\n'''
replace_once(path, old, new, 'repository staged group configuration')

old = '''    this.disposables.push(this.changes);\n    this.disposables.push(this.conflicts);\n'''
new = '''    this.disposables.push(this.staged);\n    this.disposables.push(this.changes);\n    this.disposables.push(this.conflicts);\n'''
replace_once(path, old, new, 'repository staged group disposal')

# Coordinator adopts the repository-owned group and never disposes or removes it.
path = 'src/stagingCoordinator.ts'
old = '''    const group = repository.sourceControl.createResourceGroup(\n      "staged",\n      "Staged Changes"\n    ) as ISvnResourceGroup;\n    group.hideWhenEmpty = true;\n    group.repository = repository;\n    repository.staged = group;\n\n'''
new = '''    const group = repository.staged;\n    if (!group) return;\n\n'''
replace_once(path, old, new, 'coordinator adopts staged group')

old = '''    state.disposables.push(\n      group,\n      repository.onDidRebuildStatusProjection(() => this.reconcile(repository))\n    );\n'''
new = '''    state.disposables.push(\n      repository.onDidRebuildStatusProjection(() => this.reconcile(repository))\n    );\n'''
replace_once(path, old, new, 'coordinator stops owning staged group')

old = '''    if (repository.staged === state.group) {\n      repository.staged = undefined;\n    }\n    repository.stagedChangelists.clear();\n'''
new = '''    state.group.resourceStates = [];\n    repository.stagedChangelists.clear();\n'''
replace_once(path, old, new, 'coordinator detach keeps staged group')

# Integration invariant: Staged Changes exists before the coordinator has any
# content and remains the same group through staging lifecycle.
path = 'src/test/staging.test.ts'
marker = '''  test("unstage restores a pre-existing user changelist", async () => {\n'''
test = '''  test("repository owns one persistent staged group above Changes", async () => {\n    const checkout = await createCheckoutWithFiles();\n    await sourceControlManager.tryOpenRepository(checkout.fsPath);\n    const repository = sourceControlManager.getRepository(\n      checkout\n    ) as Repository;\n    opened.push(repository);\n\n    const stagedGroup = repository.staged;\n    assert.ok(stagedGroup);\n    assert.equal(stagedGroup.id, "staged");\n    assert.equal(stagedGroup.label, "Staged Changes");\n    assert.equal(stagedGroup.hideWhenEmpty, true);\n    assert.equal(stagedGroup.repository, repository);\n\n    const file = path.join(checkout.fsPath, "one", "a.txt");\n    fs.writeFileSync(file, "ordered staging edit\\n");\n    await repository.status();\n    const resource = repository.changes.resourceStates.find(\n      item => item.resourceUri.fsPath === file\n    );\n    assert.ok(resource);\n    await commands.executeCommand("svn.stage", resource);\n\n    assert.strictEqual(repository.staged, stagedGroup);\n    assert.equal(\n      stagedGroup.resourceStates.some(item => item.resourceUri.fsPath === file),\n      true\n    );\n  });\n\n'''
replace_once(path, marker, test + marker, 'staged group ownership regression')
