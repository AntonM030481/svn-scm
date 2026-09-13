const fs = require('node:fs');

function patch(path, edits) {
  let s = fs.readFileSync(path, 'utf8');
  for (const [oldText, newText] of edits) {
    if (!s.includes(oldText)) throw new Error(`anchor not found in ${path}: ${oldText.slice(0, 80)}`);
    s = s.replace(oldText, newText);
  }
  fs.writeFileSync(path, s, 'utf8');
}

patch('src/repository.ts', [
  [
    '  public unversioned: ISvnResourceGroup;\n  public remoteChanges?: ISvnResourceGroup;\n',
    '  public unversioned: ISvnResourceGroup;\n  public staged?: ISvnResourceGroup;\n  public remoteChanges?: ISvnResourceGroup;\n'
  ],
  [
    '    this.unversioned.resourceStates = [];\n    this.conflicts.resourceStates = [];\n',
    '    this.unversioned.resourceStates = [];\n    if (this.staged) {\n      this.staged.resourceStates = [];\n    }\n    this.conflicts.resourceStates = [];\n'
  ],
  [
    '      this.unversioned,\n      ...this.changelists.values()\n',
    '      this.unversioned,\n      ...(this.staged ? [this.staged] : []),\n      ...this.changelists.values()\n'
  ]
]);

patch('src/stagingCoordinator.ts', [
  [
    '    group.hideWhenEmpty = true;\n\n    const state: RepositoryStagingState = {\n',
    '    group.hideWhenEmpty = true;\n    group.repository = repository;\n    repository.staged = group;\n\n    const state: RepositoryStagingState = {\n'
  ],
  [
    '    while (state.disposables.length) {\n      state.disposables.pop()?.dispose();\n    }\n    this.states.delete(repository);\n',
    '    while (state.disposables.length) {\n      state.disposables.pop()?.dispose();\n    }\n    if (repository.staged === state.group) {\n      repository.staged = undefined;\n    }\n    this.states.delete(repository);\n'
  ]
]);

patch('src/test/staging.test.ts', [
  [
    '    await commands.executeCommand("svn.stage", userResource);\n    assert.ok(\n      repository.changelists.has(createStagingChangelist("personal-work"))\n    );\n\n    await commands.executeCommand("svn.unstage", userResource);\n',
    '    await commands.executeCommand("svn.stage", userResource);\n    assert.ok(\n      repository.changelists.has(createStagingChangelist("personal-work"))\n    );\n    assert.equal(repository.getResourceFromFile(Uri.file(file))?.resourceUri.fsPath, file);\n    assert.equal(repository.staged?.repository, repository);\n    assert.equal(sourceControlManager.getRepository(repository.staged), repository);\n\n    await commands.executeCommand("svn.unstage", userResource);\n'
  ]
]);
