import * as assert from "assert";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { IFileStatus, Status } from "../common/types";
import {
  isSnapshotPath,
  readStatusSnapshot,
  mergeStartupStatus,
  selectStartupTargets,
  STARTUP_MAX_FILE_BYTES,
  StatusSnapshotStore,
  workingCopyIdentity
} from "../statusSnapshot";

function status(file: string, state = Status.MODIFIED): IFileStatus {
  return {
    path: file,
    status: state,
    props: "none",
    wcStatus: { locked: false, switched: false }
  };
}

suite("Status snapshot", () => {
  test("rejects incompatible identities, malformed entries and escaping paths", () => {
    const snapshot = { version: 1, identity: "wc", statuses: [status("a")] };
    assert.equal(readStatusSnapshot(snapshot, "another"), undefined);
    assert.equal(
      readStatusSnapshot({ ...snapshot, version: 2 }, "wc"),
      undefined
    );
    for (const file of [
      "../a",
      "a/../../b",
      "/tmp/a",
      "C:\\a",
      "C:a",
      "\\\\server\\share",
      "a/.svn/wc.db",
      "a\0"
    ]) {
      assert.equal(isSnapshotPath(file), false, file);
      assert.equal(
        readStatusSnapshot({ ...snapshot, statuses: [status(file)] }, "wc"),
        undefined
      );
    }
    assert.equal(
      readStatusSnapshot(
        { ...snapshot, statuses: [{ ...status("a"), wcStatus: null }] },
        "wc"
      ),
      undefined
    );
    assert.equal(
      readStatusSnapshot(
        { ...snapshot, statuses: [status("a"), status("./a")] },
        "wc"
      ),
      undefined
    );
    assert.deepEqual(readStatusSnapshot(snapshot, "wc"), snapshot.statuses);
  });

  test("only explicit checked results replace entries; remote and unchecked state survive", () => {
    const saved = [
      status("clean"),
      status("big"),
      status("missing"),
      { ...status("props"), reposStatus: { item: "modified", props: "none" } }
    ];
    const updated = [
      status("clean", Status.NORMAL),
      {
        ...status("props", Status.NORMAL),
        props: "modified",
        changelist: "work"
      },
      status("outside")
    ];
    const merged = mergeStartupStatus(
      saved,
      ["clean", "missing", "props"],
      updated
    );
    assert.equal(merged.find(s => s.path === "clean")!.status, Status.NORMAL);
    assert.deepEqual(
      merged.find(s => s.path === "big"),
      saved[1]
    );
    assert.deepEqual(
      merged.find(s => s.path === "missing"),
      saved[2]
    );
    assert.equal(merged.find(s => s.path === "props")!.changelist, "work");
    assert.deepEqual(
      merged.find(s => s.path === "props")!.reposStatus,
      saved[3].reposStatus
    );
    assert.ok(!merged.some(s => s.path === "outside"));
  });

  test("bounds selection by count, individual size and total bytes without reading contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "svn-snapshot-"));
    try {
      const statuses: IFileStatus[] = [];
      for (let i = 0; i < 6; i++) {
        const file = `file${i}`;
        const handle = await fs.open(path.join(root, file), "w");
        await handle.truncate(STARTUP_MAX_FILE_BYTES);
        await handle.close();
        statuses.push(status(file));
      }
      const large = await fs.open(path.join(root, "large"), "w");
      await large.truncate(STARTUP_MAX_FILE_BYTES + 1);
      await large.close();
      await fs.mkdir(path.join(root, "directory"));
      statuses.push(status("large"), status("directory"), status("missing"));
      assert.deepEqual(await selectStartupTargets(root, statuses), [
        "file0",
        "file1",
        "file2",
        "file3",
        "file4"
      ]);
      assert.deepEqual(
        await selectStartupTargets(
          root,
          Array.from({ length: 51 }, (_, i) => status(`x${i}`))
        ),
        []
      );
      assert.deepEqual(
        await selectStartupTargets(root, [
          status("file0"),
          { ...status("file1"), rename: "old" }
        ]),
        ["file0"]
      );
      assert.deepEqual(
        await selectStartupTargets(root, [
          ...Array.from({ length: 49 }, (_, i) => status(`absent${i}`)),
          status("file0")
        ]),
        ["file0"]
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("distinguishes modern nested roots from legacy per-directory metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "svn-layout-"));
    try {
      for (const admin of [".svn", "_svn"]) {
        const directory = path.join(
          root,
          admin === ".svn" ? "modern" : "alternate"
        );
        await fs.mkdir(path.join(directory, admin), { recursive: true });
        const file = path.join(directory, "file.txt");
        await fs.writeFile(file, "changed");
        const relative = path.relative(root, file);
        assert.deepEqual(
          await selectStartupTargets(root, [status(relative)]),
          []
        );
        assert.deepEqual(
          await selectStartupTargets(root, [status(relative)], true),
          [relative]
        );
        assert.deepEqual(
          await selectStartupTargets(
            root,
            [
              status(relative),
              status(path.relative(root, directory), Status.EXTERNAL)
            ],
            true
          ),
          []
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("serializes writes, detaches live objects and isolates workspace scopes", async () => {
    const data = new Map<string, unknown>();
    const state = {
      keys: () => [...data.keys()],
      get: <T>(key: string) => data.get(key) as T,
      update: async (key: string, value: unknown) => {
        data.set(key, value);
      }
    };
    const store = new StatusSnapshotStore(state, "/wc", "/wc");
    const statuses = [status("a")];
    const first = store.write("identity", statuses);
    statuses[0].wcStatus.locked = true;
    await first;
    assert.equal(store.read("identity")![0].wcStatus.locked, false);
    await Promise.all([
      store.write("identity", [status("b")]),
      store.write("identity", [status("c")])
    ]);
    assert.equal(store.read("identity")![0].path, "c");
    assert.equal(
      new StatusSnapshotStore(state, "/wc", "/wc/sub").read("identity"),
      undefined
    );
  });

  test("working-copy replacement and URL changes invalidate identity; ordinary metadata writes do not", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "svn-identity-"));
    try {
      await fs.mkdir(path.join(root, ".svn"));
      const identity = () =>
        workingCopyIdentity(root, root, "uuid", "url", ".svn");
      const initial = await identity();
      await fs.writeFile(path.join(root, ".svn", "wc.db"), "metadata");
      assert.equal(await identity(), initial);
      assert.notEqual(
        await workingCopyIdentity(root, root, "uuid", "other-url", ".svn"),
        initial
      );
      await fs.rename(path.join(root, ".svn"), path.join(root, ".old"));
      await fs.mkdir(path.join(root, ".svn"));
      assert.notEqual(await identity(), initial);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
