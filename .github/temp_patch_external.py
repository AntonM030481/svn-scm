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
    "src/svnRepository.ts",
    "    checkRemoteChanges?: boolean;\n  }): Promise<IFileStatus[]> {",
    "    checkRemoteChanges?: boolean;\n    resolveExternalRepositoryUuid?: boolean;\n  }): Promise<IFileStatus[]> {",
)
replace(
    "src/svnRepository.ts",
    "      if (s.status === Status.EXTERNAL) {",
    "      if (\n        params.resolveExternalRepositoryUuid &&\n        s.status === Status.EXTERNAL\n      ) {",
)

replace(
    "src/incrementalStatus.ts",
    "  checkRemoteChanges?: boolean;\n}",
    "  checkRemoteChanges?: boolean;\n  resolveExternalRepositoryUuid?: boolean;\n}",
)
replace(
    "src/incrementalStatus.ts",
    "    if (status.status !== Status.EXTERNAL) {",
    "    if (\n      !params.resolveExternalRepositoryUuid ||\n      status.status !== Status.EXTERNAL\n    ) {",
)

replace(
    "src/repository.ts",
    "          includeExternals: combineExternal,\n          checkRemoteChanges",
    "          includeExternals: combineExternal,\n          checkRemoteChanges,\n          resolveExternalRepositoryUuid: combineExternal",
)

test_block = '''  test("Resolves external repository UUID only when requested", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tmp",
      ConstructorPolicy.LateInit
    );
    repository.exec = async (_args: string[], _options?: ICpOptions) => ({
      exitCode: 0,
      stderr: "",
      stdout: `<?xml version="1.0" encoding="UTF-8"?>
        <status>
          <target path=".">
            <entry path="external-a">
              <wc-status item="external" props="none" />
            </entry>
            <entry path="external-b">
              <wc-status item="external" props="none" />
            </entry>
          </target>
        </status>`
    });

    let getInfoCalls = 0;
    repository.getInfo = async () => {
      getInfoCalls += 1;
      return info;
    };

    const defaultStatus = await repository.getStatus({});
    assert.equal(getInfoCalls, 0);
    assert.equal(defaultStatus[0].repositoryUuid, undefined);
    assert.equal(defaultStatus[1].repositoryUuid, undefined);

    const resolvedStatus = await repository.getStatus({
      resolveExternalRepositoryUuid: true
    });
    assert.equal(getInfoCalls, 2);
    assert.equal(resolvedStatus[0].repositoryUuid, info.repository.uuid);
    assert.equal(resolvedStatus[1].repositoryUuid, info.repository.uuid);
  });

'''
replace(
    "src/test/svnRepository.test.ts",
    '  test("Test multiple status targets", async () => {',
    test_block + '  test("Test multiple status targets", async () => {',
)
