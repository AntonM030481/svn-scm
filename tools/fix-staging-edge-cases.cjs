const fs = require('node:fs');

function patch(file, edits) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [oldText, newText] of edits) {
    if (!s.includes(oldText)) throw new Error(`anchor not found in ${file}: ${oldText.slice(0, 100)}`);
    s = s.replace(oldText, newText);
  }
  fs.writeFileSync(file, s, 'utf8');
}

patch('src/repository.ts', [
  [
    '  public staged?: ISvnResourceGroup;\n  public remoteChanges?: ISvnResourceGroup;\n',
    '  public staged?: ISvnResourceGroup;\n  public stagedChangelists: Map<string, string> = new Map();\n  public remoteChanges?: ISvnResourceGroup;\n'
  ],
  [
    '    if (this.staged) {\n      this.staged.resourceStates = [];\n    }\n    this.conflicts.resourceStates = [];\n',
    '    if (this.staged) {\n      this.staged.resourceStates = [];\n    }\n    this.stagedChangelists.clear();\n    this.conflicts.resourceStates = [];\n'
  ]
]);

patch('src/incrementalStatus.ts', [
  [
    '  append(repository.changes.resourceStates);\n  append(repository.conflicts.resourceStates);\n  append(repository.unversioned.resourceStates);\n  repository.changelists.forEach((group, changelist) => {\n',
    '  append(repository.changes.resourceStates);\n  append(repository.conflicts.resourceStates);\n  append(repository.unversioned.resourceStates);\n  if (repository.staged) {\n    for (const resource of repository.staged.resourceStates) {\n      const changelist = repository.stagedChangelists.get(\n        normalizePath(resource.resourceUri.fsPath)\n      );\n      if (changelist) {\n        append([resource], changelist);\n      }\n    }\n  }\n  repository.changelists.forEach((group, changelist) => {\n'
  ]
]);

patch('src/stagingCoordinator.ts', [
  [
    'import { Disposable, SourceControlResourceGroup } from "vscode";\n',
    'import { Disposable, SourceControlResourceGroup, window } from "vscode";\n'
  ],
  [
    '    if (repository.staged === state.group) {\n      repository.staged = undefined;\n    }\n    this.states.delete(repository);\n',
    '    if (repository.staged === state.group) {\n      repository.staged = undefined;\n    }\n    repository.stagedChangelists.clear();\n    this.states.delete(repository);\n'
  ],
  [
    '    const staged: Resource[] = [];\n    state.metadataByPath.clear();\n\n    for (const [changelist, group] of repository.changelists) {\n',
    '    const staged: Resource[] = [];\n    state.metadataByPath.clear();\n    repository.stagedChangelists.clear();\n\n    for (const [changelist, group] of repository.changelists) {\n'
  ],
  [
    '        state.metadataByPath.set(\n          normalizePath(resource.resourceUri.fsPath),\n          changelist\n        );\n',
    '        const key = normalizePath(resource.resourceUri.fsPath);\n        state.metadataByPath.set(key, changelist);\n        repository.stagedChangelists.set(key, changelist);\n'
  ],
  [
    '    const regular: Resource[] = [];\n    const unversioned: Resource[] = [];\n\n    for (const resource of selected) {\n      const current = this.currentChangelist(repository, resource);\n      if (current && isStagingChangelist(current)) continue;\n      if (resource.type === Status.UNVERSIONED) unversioned.push(resource);\n      else regular.push(resource);\n    }\n\n    if (unversioned.length) {\n',
    '    const regular: Resource[] = [];\n    const unversioned: Resource[] = [];\n    let skippedDirectories = 0;\n\n    for (const resource of selected) {\n      const current = this.currentChangelist(repository, resource);\n      if (current && isStagingChangelist(current)) continue;\n      if (resource.type === Status.UNVERSIONED) {\n        unversioned.push(resource);\n        continue;\n      }\n\n      if (await this.isDirectoryResource(repository, resource)) {\n        skippedDirectories += 1;\n        continue;\n      }\n      regular.push(resource);\n    }\n\n    if (skippedDirectories) {\n      await window.showWarningMessage(\n        "SVN staging currently supports file changes only. Directory-only changes remain in Changes and can be committed with Commit All."\n      );\n    }\n\n    if (unversioned.length) {\n'
  ],
  [
    '        if (fileDescendants.length) {\n          await repository.addChangelist(\n            fileDescendants,\n            createStagingChangelist(undefined, true)\n          );\n        }\n',
    '        if (fileDescendants.length) {\n          await repository.addChangelist(\n            fileDescendants,\n            createStagingChangelist(undefined, true)\n          );\n        } else {\n          await repository.revert([directory], "infinity");\n          await window.showWarningMessage(\n            "Empty directories cannot be staged because SVN changelists apply only to files."\n          );\n        }\n'
  ],
  [
    '  private resourcesUnderPath(\n',
    '  private async isDirectoryResource(\n    repository: Repository,\n    resource: Resource\n  ): Promise<boolean> {\n    try {\n      return (await stat(resource.resourceUri.fsPath)).isDirectory();\n    } catch {\n      try {\n        return (await repository.info(resource.resourceUri.fsPath)).kind === "dir";\n      } catch {\n        return false;\n      }\n    }\n  }\n\n  private resourcesUnderPath(\n'
  ],
  [
    '    await repository.removeChangelist(paths);\n    if (metadata.wasUnversioned) {\n      await repository.revert(paths, "empty");\n    }\n',
    '    const addedDirectories = metadata.wasUnversioned\n      ? this.addedAncestorDirectoriesForUnstage(repository, paths)\n      : [];\n\n    await repository.removeChangelist(paths);\n    if (metadata.wasUnversioned) {\n      await repository.revert(paths, "empty");\n      for (const directory of addedDirectories) {\n        await repository.revert([directory], "empty");\n      }\n    }\n'
  ],
  [
    '  private async restoreDestination(\n',
    '  private addedAncestorDirectoriesForUnstage(\n    repository: Repository,\n    paths: string[]\n  ): string[] {\n    const selected = new Set(paths.map(normalizePath));\n    const candidates = new Set<string>();\n\n    for (const filePath of paths) {\n      let directory = path.dirname(filePath);\n      while (\n        directory !== path.dirname(directory) &&\n        normalizePath(directory) !== normalizePath(repository.root)\n      ) {\n        if (this.findResource(repository, directory)?.type === Status.ADDED) {\n          candidates.add(normalizePath(directory));\n        }\n        directory = path.dirname(directory);\n      }\n    }\n\n    const added = this.resourcesUnderPath(repository, repository.workspaceRoot)\n      .filter(resource => resource.type === Status.ADDED)\n      .map(resource => normalizePath(resource.resourceUri.fsPath));\n\n    return [...candidates]\n      .filter(directory =>\n        !added.some(\n          resourcePath =>\n            resourcePath !== directory &&\n            isPathInside(directory, resourcePath) &&\n            !selected.has(resourcePath) &&\n            !candidates.has(resourcePath)\n        )\n      )\n      .sort((left, right) => right.length - left.length);\n  }\n\n  private async restoreDestination(\n'
  ]
]);

patch('docs/staging.md', [
  [
    'SVN changelists apply to files, not directories. Folder staging therefore expands the relevant changed files. Newly staged unversioned files are first scheduled with `svn add` and then placed in the reserved staging changelist.\n',
    'SVN changelists apply to files, not directories. Staging an unversioned folder therefore expands its file descendants; added parent directories are included explicitly in Commit Staged with SVN `--depth empty`, so unstaged siblings are never committed recursively. Unstage restores directory additions created by that staging operation when no staged or unrelated added descendants still require them. Empty directories and directory-only versioned changes (for example, a directory property change) remain in `Changes` and should use Commit All because SVN cannot place them in a changelist.\n'
  ]
]);

patch('src/test/staging.test.ts', [
  [
    '  test("one staged commit spans sibling workspace folders in the same WC", async () => {\n',
    `  test("staged files survive sequential targeted staging operations", async () => {\n    const checkout = await createCheckoutWithFiles();\n    await sourceControlManager.tryOpenRepository(checkout.fsPath);\n    const repository = sourceControlManager.getRepository(checkout) as Repository;\n    opened.push(repository);\n\n    const fileOne = path.join(checkout.fsPath, "one", "a.txt");\n    const fileTwo = path.join(checkout.fsPath, "two", "b.txt");\n    fs.writeFileSync(fileOne, "a1\\n");\n    fs.writeFileSync(fileTwo, "b1\\n");\n    await repository.status();\n\n    const resourceOne = repository.changes.resourceStates.find(\n      item => item.resourceUri.fsPath === fileOne\n    );\n    const resourceTwo = repository.changes.resourceStates.find(\n      item => item.resourceUri.fsPath === fileTwo\n    );\n    assert.ok(resourceOne);\n    assert.ok(resourceTwo);\n\n    await commands.executeCommand("svn.stage", resourceOne);\n    await commands.executeCommand("svn.stage", resourceTwo);\n\n    assert.equal(repository.staged?.resourceStates.length, 2);\n    assert.ok(repository.getResourceFromFile(Uri.file(fileOne)));\n    assert.ok(repository.getResourceFromFile(Uri.file(fileTwo)));\n\n    repository.inputBox.value = "sequential staged commit";\n    await commands.executeCommand("svn.commitStaged", repository.sourceControl);\n    assert.equal(svn(["status"], checkout.fsPath).trim(), "");\n  });\n\n  test("unstaging an unversioned folder restores its scheduled additions", async () => {\n    const checkout = await createCheckoutWithFiles();\n    await sourceControlManager.tryOpenRepository(checkout.fsPath);\n    const repository = sourceControlManager.getRepository(checkout) as Repository;\n    opened.push(repository);\n\n    const directory = path.join(checkout.fsPath, "new-folder");\n    fs.mkdirSync(directory);\n    fs.writeFileSync(path.join(directory, "new.txt"), "new\\n");\n    await repository.status();\n\n    const resource = repository.unversioned.resourceStates.find(\n      item => item.resourceUri.fsPath === directory\n    );\n    assert.ok(resource);\n\n    await commands.executeCommand("svn.stage", resource);\n    assert.match(svn(["status"], checkout.fsPath), /^A\\s+new-folder/m);\n\n    await commands.executeCommand("svn.unstageAll", repository.staged);\n    const status = svn(["status"], checkout.fsPath);\n    assert.doesNotMatch(status, /^A\\s+new-folder/m);\n    assert.match(status, /^\\?\\s+new-folder/m);\n  });\n\n  test("directory-only versioned changes stay unstaged", async () => {\n    const checkout = await createCheckoutWithFiles();\n    await sourceControlManager.tryOpenRepository(checkout.fsPath);\n    const repository = sourceControlManager.getRepository(checkout) as Repository;\n    opened.push(repository);\n\n    const directory = path.join(checkout.fsPath, "one");\n    svn(["propset", "stage-test", "value", directory], checkout.fsPath);\n    await repository.status();\n\n    const resource = repository.changes.resourceStates.find(\n      item => item.resourceUri.fsPath === directory\n    );\n    assert.ok(resource);\n\n    await commands.executeCommand("svn.stage", resource);\n    assert.equal(\n      repository.staged?.resourceStates.some(\n        item => item.resourceUri.fsPath === directory\n      ),\n      false\n    );\n    assert.equal(\n      repository.changes.resourceStates.some(\n        item => item.resourceUri.fsPath === directory\n      ),\n      true\n    );\n  });\n\n  test("one staged commit spans sibling workspace folders in the same WC", async () => {\n`
  ]
]);
