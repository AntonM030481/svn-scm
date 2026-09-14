from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{label} not found in {path}")
    p.write_text(text.replace(old, new, 1))

# Create Staged Changes before Changes so VS Code renders it above Changes,
# matching the built-in Git provider's group ordering.
path = "src/repository.ts"
old = '''    this.changes = this.sourceControl.createResourceGroup(\n      "changes",\n      "Changes"\n    ) as ISvnResourceGroup;\n    this.conflicts = this.sourceControl.createResourceGroup(\n'''
new = '''    this.staged = this.sourceControl.createResourceGroup(\n      "staged",\n      "Staged Changes"\n    ) as ISvnResourceGroup;\n    this.changes = this.sourceControl.createResourceGroup(\n      "changes",\n      "Changes"\n    ) as ISvnResourceGroup;\n    this.conflicts = this.sourceControl.createResourceGroup(\n'''
replace_once(path, old, new, "staged group creation order")

old = '''    this.changes.repository = this;\n    this.conflicts.repository = this;\n    this.unversioned.repository = this;\n    this.changes.hideWhenEmpty = true;\n    this.unversioned.hideWhenEmpty = true;\n    this.conflicts.hideWhenEmpty = true;\n\n    this.disposables.push(this.changes);\n    this.disposables.push(this.conflicts);\n'''
new = '''    this.staged.repository = this;\n    this.changes.repository = this;\n    this.conflicts.repository = this;\n    this.unversioned.repository = this;\n    this.staged.hideWhenEmpty = true;\n    this.changes.hideWhenEmpty = true;\n    this.unversioned.hideWhenEmpty = true;\n    this.conflicts.hideWhenEmpty = true;\n\n    this.disposables.push(this.staged);\n    this.disposables.push(this.changes);\n    this.disposables.push(this.conflicts);\n'''
replace_once(path, old, new, "staged group ownership")

# Coordinator owns staging state, not the lifetime/order of the SCM group.
path = "src/stagingCoordinator.ts"
old = '''    const group = repository.sourceControl.createResourceGroup(\n      "staged",\n      "Staged Changes"\n    ) as ISvnResourceGroup;\n    group.hideWhenEmpty = true;\n    group.repository = repository;\n    repository.staged = group;\n'''
new = '''    const group = repository.staged;\n    if (!group) {\n      throw new Error("Repository staging group is unavailable");\n    }\n    group.resourceStates = [];\n'''
replace_once(path, old, new, "coordinator reuses staged group")

old = '''    state.disposables.push(\n      group,\n      repository.onDidRebuildStatusProjection(() => this.reconcile(repository))\n    );\n'''
new = '''    state.disposables.push(\n      repository.onDidRebuildStatusProjection(() => this.reconcile(repository))\n    );\n'''
replace_once(path, old, new, "coordinator group disposal")

old = '''    if (repository.staged === state.group) {\n      repository.staged = undefined;\n    }\n    repository.stagedChangelists.clear();\n'''
new = '''    state.group.resourceStates = [];\n    repository.stagedChangelists.clear();\n'''
replace_once(path, old, new, "coordinator detach keeps staged group")
