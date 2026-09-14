from pathlib import Path

p = Path('src/stagingCoordinator.ts')
s = p.read_text()
old = '''    const validated: Resource[] = [];
    for (const [repository, selected] of byRepository) {
      await refreshStatusTargets(
        repository,
        selected.map(resource => resource.resourceUri.fsPath)
      );
      const staged = this.states.get(repository)?.group.resourceStates ?? [];
'''
new = '''    const validated: Resource[] = [];
    for (const [repository, selected] of byRepository) {
      if (await this.needsFullStatus(selected)) {
        await repository.fullStatus();
      } else {
        await refreshStatusTargets(
          repository,
          selected.map(resource => resource.resourceUri.fsPath)
        );
      }
      const staged = this.states.get(repository)?.group.resourceStates ?? [];
'''
if old not in s:
    raise SystemExit('validation refresh block not found')
s = s.replace(old, new, 1)

marker = '''  private async refreshProjectionsContainingPaths(
'''
helper = '''  private async needsFullStatus(resources: Resource[]): Promise<boolean> {
    for (const resource of resources) {
      try {
        if ((await lstat(resource.resourceUri.fsPath)).isSymbolicLink()) {
          return true;
        }
      } catch {
        // Missing paths are validated by SVN status itself.
      }
    }
    return false;
  }

'''
if marker not in s:
    raise SystemExit('refresh marker not found')
s = s.replace(marker, helper + marker, 1)

old = '''  private async refreshProjectionsContainingPaths(
    repository: Repository,
    resources: Resource[]
  ): Promise<void> {
'''
new = '''  private async refreshProjectionsContainingPaths(
    repository: Repository,
    resources: Resource[],
    forceFullStatus: boolean = false
  ): Promise<void> {
'''
if old not in s:
    raise SystemExit('refresh signature not found')
s = s.replace(old, new, 1)

old = '''    await Promise.all(
      peers.map(peer =>
        refreshStatusTargets(
          peer,
          filePaths.filter(filePath => isPathInside(peer.workspaceRoot, filePath))
        )
      )
    );
'''
new = '''    await Promise.all(
      peers.map(peer =>
        forceFullStatus
          ? peer.fullStatus()
          : refreshStatusTargets(
              peer,
              filePaths.filter(filePath =>
                isPathInside(peer.workspaceRoot, filePath)
              )
            )
      )
    );
'''
if old not in s:
    raise SystemExit('peer refresh body not found')
s = s.replace(old, new, 1)

old = '''    for (const [repository, selected] of byRepository) {
      await this.stageInRepository(repository, selected);
      await this.refreshProjectionsContainingPaths(repository, selected);
    }
'''
new = '''    for (const [repository, selected] of byRepository) {
      const forceFullStatus = await this.needsFullStatus(selected);
      await this.stageInRepository(repository, selected);
      if (forceFullStatus) {
        await repository.fullStatus();
      }
      await this.refreshProjectionsContainingPaths(
        repository,
        selected,
        forceFullStatus
      );
    }
'''
if old not in s:
    raise SystemExit('stage refresh block not found')
s = s.replace(old, new, 1)

old = '''      for (const [stagingChangelist, resources] of grouped) {
        const metadata = parseStagingChangelist(stagingChangelist);
        if (!metadata) continue;
        await this.restoreDestination(repository, resources, metadata);
      }
      await this.refreshProjectionsContainingPaths(repository, selected);
'''
new = '''      const forceFullStatus = await this.needsFullStatus(selected);
      for (const [stagingChangelist, resources] of grouped) {
        const metadata = parseStagingChangelist(stagingChangelist);
        if (!metadata) continue;
        await this.restoreDestination(repository, resources, metadata);
      }
      if (forceFullStatus) {
        await repository.fullStatus();
      }
      await this.refreshProjectionsContainingPaths(
        repository,
        selected,
        forceFullStatus
      );
'''
if old not in s:
    raise SystemExit('unstage refresh block not found')
s = s.replace(old, new, 1)
p.write_text(s)
