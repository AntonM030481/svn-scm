import * as assert from "assert";
import * as path from "path";
import { Uri } from "vscode";
import {
  ConstructorPolicy,
  ICpOptions,
  ISvnInfo,
  ISvnOptions
} from "../common/types";
import { parseStatusXml } from "../parser/statusParser";
import { Svn, svnErrorCodes } from "../svn";
import SvnError from "../svnError";
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

  test("show and showBuffer share local revision target resolution", async () => {
    svn = new Svn(options);
    const workspaceRoot = path.resolve("show-target");
    const file = path.join(workspaceRoot, "nested", "file.txt");
    const repository = await new Repository(
      svn,
      workspaceRoot,
      workspaceRoot,
      ConstructorPolicy.LateInit
    );
    repository.getInfo = async () => info;

    const calls: string[][] = [];
    repository.exec = async args => {
      calls.push(args);
      return { exitCode: 0, stderr: "", stdout: "text" };
    };
    repository.execBuffer = async args => {
      calls.push(args);
      return {
        exitCode: 0,
        stderr: "",
        stdout: Buffer.from("raw")
      };
    };

    assert.equal(await repository.show(file, "42"), "text");
    assert.deepEqual(
      await repository.showBuffer(file, "42"),
      Buffer.from("raw")
    );
    assert.deepEqual(calls, [
      ["cat", "-r", "42", `${info.url}/nested/file.txt`],
      ["cat", "-r", "42", `${info.url}/nested/file.txt`]
    ]);
  });

  test("log preserves explicit working-copy paths and repository URLs", async () => {
    svn = new Svn(options);
    const workspaceRoot = path.resolve("log-target");
    const repository = await new Repository(
      svn,
      workspaceRoot,
      workspaceRoot,
      ConstructorPolicy.LateInit
    );
    const calls: string[][] = [];
    repository.exec = async args => {
      calls.push(args);
      return { exitCode: 0, stderr: "", stdout: "<log></log>" };
    };

    const file = Uri.file(path.join(workspaceRoot, "user@host.txt"));
    const remote = Uri.parse("file:///svn/project/file.txt");
    await repository.log("HEAD", "0", 10, file.fsPath);
    await repository.log("HEAD", "0", 10, remote.toString(true));

    assert.deepEqual(calls, [
      ["log", "-r", "HEAD:0", "--limit=10", "--xml", "-v", `${file.fsPath}@`],
      [
        "log",
        "-r",
        "HEAD:0",
        "--limit=10",
        "--xml",
        "-v",
        remote.toString(true)
      ]
    ]);
  });

  test("reads svn:ignore through XML without trimming patterns", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tmp",
      ConstructorPolicy.LateInit
    );
    repository.exec = async args => {
      assert.deepStrictEqual(args, [
        "propget",
        "svn:ignore",
        "--xml",
        "folder"
      ]);
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          '<properties><target path="folder"><property name="svn:ignore">  spaced pattern  \na&amp;b</property></target></properties>'
      };
    };

    assert.deepStrictEqual(await repository.getCurrentIgnore("/tmp/folder"), [
      "  spaced pattern  ",
      "a&b"
    ]);
  });

  test("returns no ignores only when the property is absent", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tmp",
      ConstructorPolicy.LateInit
    );
    repository.exec = async () => {
      throw new SvnError({ svnErrorCode: svnErrorCodes.PropertyNotFound });
    };

    assert.deepStrictEqual(await repository.getCurrentIgnore("/tmp"), []);
  });

  test("propagates svn:ignore parse failures", async () => {
    svn = new Svn(options);
    const repository = await new Repository(
      svn,
      "/tmp",
      "/tmp",
      ConstructorPolicy.LateInit
    );
    repository.exec = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "<malformed"
    });

    await assert.rejects(repository.getCurrentIgnore("/tmp"));
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

  test("Update accepts multiple explicit working-copy targets", async () => {
    svn = new Svn(options);
    const workspaceRoot = path.resolve("update-targets");
    const repository = await new Repository(
      svn,
      workspaceRoot,
      workspaceRoot,
      ConstructorPolicy.LateInit
    );
    const targets = [
      path.join(workspaceRoot, "one"),
      path.join(workspaceRoot, "two")
    ];
    let args: string[] = [];
    repository.exec = async commandArgs => {
      args = commandArgs;
      return { exitCode: 0, stderr: "", stdout: "Updated to revision 42.\n" };
    };

    assert.equal(
      await repository.update(true, targets),
      "Updated to revision 42."
    );
    assert.deepEqual(args, ["update", "--ignore-externals", ...targets]);
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

  test("Skips info execution when its owner is already inactive", async () => {
    const repository = await new Repository(
      new Svn(options),
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    let calls = 0;
    repository.exec = async () => {
      calls++;
      throw new Error("must not execute");
    };
    repository.setInfoOwner(() => false);
    await repository.updateInfo();
    assert.equal(calls, 0);
    assert.strictEqual(repository.info, info);
  });

  test("Rejects stale info results without replacing the previous cache", async () => {
    const repository = await new Repository(
      new Svn(options),
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    let active = true;
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    repository.exec = async () => {
      markStarted();
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          '<info><entry kind="dir" path="." revision="43"><url>https://example.test/svn/project/trunk</url></entry></info>'
      };
    };
    repository.setInfoOwner(() => active);
    const refresh = repository.updateInfo();
    await started;
    active = false;
    finish();
    await refresh;
    assert.strictEqual(repository.info, info);
  });

  test("Accepts refreshed info while its owner remains active", async () => {
    const repository = await new Repository(
      new Svn(options),
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    repository.exec = async () => ({
      exitCode: 0,
      stderr: "",
      stdout:
        '<info><entry kind="dir" path="." revision="43"><url>https://example.test/svn/project/trunk</url></entry></info>'
    });
    repository.setInfoOwner(() => true);
    await repository.updateInfo();
    assert.equal(repository.info.revision, "43");
  });

  for (const firstFails of [false, true]) {
    test(`Serializes info reads and recovers after failure=${firstFails}`, async () => {
      const repository = await new Repository(
        new Svn(options),
        "/wc",
        "/wc",
        ConstructorPolicy.LateInit,
        info
      );
      let calls = 0;
      let finish!: () => void;
      let finishSecond!: () => void;
      let markStarted!: () => void;
      let markSecondStarted!: () => void;
      const started = new Promise<void>(resolve => {
        markStarted = resolve;
      });
      const secondStarted = new Promise<void>(resolve => {
        markSecondStarted = resolve;
      });
      repository.exec = async () => {
        const call = ++calls;
        if (call === 1) {
          markStarted();
          await new Promise<void>(resolve => {
            finish = resolve;
          });
          if (firstFails) throw new Error("first read failed");
        } else {
          markSecondStarted();
          await new Promise<void>(resolve => {
            finishSecond = resolve;
          });
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: `<info><entry kind="dir" path="." revision="${42 + call}"><url>https://example.test/svn/project/trunk</url></entry></info>`
        };
      };
      const first = repository.updateInfo();
      const checkedFirst = firstFails
        ? assert.rejects(first, /first read failed/)
        : first;
      await started;
      const second = repository.updateInfo();
      await Promise.resolve();
      assert.equal(calls, 1);
      finish();
      await secondStarted;
      assert.strictEqual(repository.info, info);
      assert.equal(repository.isInfoCurrent, false);
      finishSecond();
      await checkedFirst;
      await second;
      assert.equal(calls, 2);
      assert.equal(repository.info.revision, "44");
    });
  }

  test("Skips a queued info read if its owner was disposed while waiting", async () => {
    const repository = await new Repository(
      new Svn(options),
      "/wc",
      "/wc",
      ConstructorPolicy.LateInit,
      info
    );
    let active = true;
    let calls = 0;
    let finish!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    repository.exec = async () => {
      calls++;
      markStarted();
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          '<info><entry kind="dir" path="." revision="43"><url>https://example.test/svn/project/trunk</url></entry></info>'
      };
    };
    repository.setInfoOwner(() => active);
    const first = repository.updateInfo();
    await started;
    const second = repository.updateInfo();
    active = false;
    finish();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.strictEqual(repository.info, info);
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
