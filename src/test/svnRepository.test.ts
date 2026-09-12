import * as assert from "assert";
import {
  ConstructorPolicy,
  ICpOptions,
  ISvnInfo,
  ISvnOptions
} from "../common/types";
import { parseStatusXml } from "../parser/statusParser";
import { Svn } from "../svn";
import { Repository } from "../svnRepository";

suite("Svn Repository Tests", () => {
  let svn: Svn | null;
  const options = {
    svnPath: "svn",
    version: "1.9"
  } as ISvnOptions;

  const info: ISvnInfo = {
    kind: "dir",
    path: ".",
    revision: "42",
    url: "https://example.test/svn/project/trunk",
    relativeUrl: "^/trunk",
    repository: {
      root: "https://example.test/svn/project",
      uuid: "test-repository-uuid"
    },
    wcInfo: {
      wcrootAbspath: "/wc",
      uuid: "test-working-copy-uuid"
    },
    commit: {
      revision: "42",
      author: "tester",
      date: "2026-09-10T00:00:00.000000Z"
    }
  };

  suiteSetup(async () => {
    // svn = new Svn(options);
  });

  suiteTeardown(() => {
    svn = null;
  });

  test("Test getStatus", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tpm",
      ConstructorPolicy.LateInit
    );
    repository.exec = async (_args: string[], _options?: ICpOptions) => {
      return {
        exitCode: 1,
        stderr: "",
        stdout: `<?xml version="1.0" encoding="UTF-8"?> <status> <target path="."> <entry path="test.php"> <wc-status item="modified" revision="19" props="none"> <commit revision="19"> <author>chris</author> <date>2018-09-06T17:26:59.815389Z</date> </commit> </wc-status> </entry> <entry path="newfiletester.php"> <wc-status item="modified" revision="19" props="none"> <commit revision="19"> <author>chris</author> <date>2018-09-06T17:26:59.815389Z</date> </commit> </wc-status> </entry> <entry path="added.php"> <wc-status item="unversioned" props="none"> </wc-status> </entry> <against revision="19"/> </target> </status>`
      };
    };

    const status = await repository.getStatus({});

    assert.equal(status[0].path, "test.php");
    assert.equal(status[1].path, "newfiletester.php");
    assert.equal(status[2].path, "added.php");
  });

  test("Resolves external repository UUID only when requested", async () => {
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

  test("Test multiple status targets", async () => {
    const status = await parseStatusXml(`<?xml version="1.0" encoding="UTF-8"?>
      <status>
        <target path="first.cpp">
          <entry path="first.cpp">
            <wc-status item="modified" revision="19" props="none" />
          </entry>
        </target>
        <target path="second.cpp">
          <entry path="second.cpp">
            <wc-status item="modified" revision="19" props="none" />
          </entry>
        </target>
      </status>`);

    assert.equal(status.length, 2);
    assert.equal(status[0].path, "first.cpp");
    assert.equal(status[1].path, "second.cpp");
  });

  test("Reuses repository root info when opening", async () => {
    svn = new Svn(options);
    let execCalls = 0;

    (svn as any).exec = async () => {
      execCalls += 1;
      return {
        exitCode: 0,
        stderr: "",
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
          <info>
            <entry kind="dir" path="." revision="42">
              <url>https://example.test/svn/project/trunk</url>
              <relative-url>^/trunk</relative-url>
              <repository>
                <root>https://example.test/svn/project</root>
                <uuid>test-repository-uuid</uuid>
              </repository>
              <wc-info>
                <wcroot-abspath>/wc</wcroot-abspath>
              </wc-info>
              <commit revision="42">
                <author>tester</author>
                <date>2026-09-10T00:00:00.000000Z</date>
              </commit>
            </entry>
          </info>`
      };
    };

    const root = await svn.getRepositoryRoot("/wc");
    const repository = await svn.open(root, "/wc");

    assert.equal(execCalls, 1);
    assert.equal(repository.info.url, info.url);
  });

  test("Gets current branch from loaded repository info", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    let getInfoCalls = 0;

    (repository as any).getInfo = async () => {
      getInfoCalls += 1;
      return info;
    };

    await repository.getCurrentBranch();

    assert.equal(getInfoCalls, 0);
  });

  test("Refreshes repository info after switching branch", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    let updateInfoCalls = 0;

    (repository as any).getRepoUrl = async () => info.repository.root;
    (repository as any).exec = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: ""
    });
    (repository as any).updateInfo = async () => {
      updateInfoCalls += 1;
    };

    await repository.switchBranch("branches/next");

    assert.equal(updateInfoCalls, 1);
  });

  test("Test rename", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tpm",
      ConstructorPolicy.LateInit
    );
    repository.exec = async (args: string[], _options?: ICpOptions) => {
      assert.equal(args[0].includes("rename"), true);
      assert.equal(args[1].includes("test.php"), true);
      assert.equal(args[2].includes("tester.php"), true);

      return {
        exitCode: 1,
        stderr: "",
        stdout: `
        A         test.php
        D         tester.php
        `
      };
    };

    await repository.rename("test.php", "tester.php");
  });
});
