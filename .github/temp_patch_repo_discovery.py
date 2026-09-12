from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    data = file.read_bytes()
    newline = "\r\n" if b"\r\n" in data else "\n"
    old_bytes = old.replace("\n", newline).encode()
    new_bytes = new.replace("\n", newline).encode()
    actual = data.count(old_bytes)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}")
    file.write_bytes(data.replace(old_bytes, new_bytes, count))


replace(
    "src/source_control_manager.ts",
    "  isDescendant,\n  isSvnFolder,",
    "  isDescendant,\n  getSvnDir,\n  isSvnFolder,",
)

replace(
    "src/source_control_manager.ts",
    'type State = "uninitialized" | "initialized";\n\nexport class SourceControlManager',
    '''type State = "uninitialized" | "initialized";

export function getSvnRepositoryPathFromMetadata(
  filePath: string,
  svnDir: string = getSvnDir()
): string | undefined {
  const normalized = filePath.replace(/\\\\/g, "/");
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

export class SourceControlManager''',
)

replace(
    "src/source_control_manager.ts",
    '''    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri => uri.scheme === "file" && !this.getRepository(uri)
    );''',
    '''    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri =>
        uri.scheme === "file" &&
        getSvnRepositoryPathFromMetadata(uri.fsPath) !== undefined &&
        !this.getRepository(uri)
    );''',
)

replace(
    "src/source_control_manager.ts",
    '''  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = uri.fsPath.replace(/\\.svn.*$/, "");
    this.eventuallyScanPossibleSvnRepository(possibleSvnRepositoryPath);
  }''',
    '''  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = getSvnRepositoryPathFromMetadata(
      uri.fsPath
    );
    if (possibleSvnRepositoryPath === undefined) {
      return;
    }

    this.eventuallyScanPossibleSvnRepository(possibleSvnRepositoryPath);
  }''',
)
