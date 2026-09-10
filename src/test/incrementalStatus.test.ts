import * as assert from "assert";
import { IFileStatus, Status } from "../common/types";
import { mergeStatuses } from "../incrementalStatus";

function status(path: string, item: Status): IFileStatus {
  return {
    path,
    status: item,
    props: Status.NONE,
    wcStatus: {
      locked: false,
      switched: false
    }
  };
}

suite("Incremental Status Tests", () => {
  test("replaces only the targeted file", () => {
    const current = [
      status("src/a.ts", Status.MODIFIED),
      status("src/b.ts", Status.MODIFIED)
    ];
    const updated = [status("src/a.ts", Status.CONFLICTED)];

    const result = mergeStatuses("/repo", current, ["/repo/src/a.ts"], updated);

    assert.equal(result.length, 2);
    assert.equal(
      result.find(item => item.path === "src/a.ts")!.status,
      Status.CONFLICTED
    );
    assert.equal(
      result.find(item => item.path === "src/b.ts")!.status,
      Status.MODIFIED
    );
  });

  test("removes a reverted file when targeted status is empty", () => {
    const current = [
      status("src/a.ts", Status.MODIFIED),
      status("src/b.ts", Status.MODIFIED)
    ];

    const result = mergeStatuses("/repo", current, ["/repo/src/a.ts"], []);

    assert.deepEqual(
      result.map(item => item.path),
      ["src/b.ts"]
    );
  });

  test("replaces a targeted subtree and preserves other changes", () => {
    const current = [
      status("src/feature/a.ts", Status.MODIFIED),
      status("src/feature/b.ts", Status.UNVERSIONED),
      status("src/other.ts", Status.MODIFIED)
    ];
    const updated = [status("src/feature/c.ts", Status.ADDED)];

    const result = mergeStatuses(
      "/repo",
      current,
      ["/repo/src/feature"],
      updated
    );

    assert.deepEqual(
      result.map(item => item.path).sort(),
      ["src/feature/c.ts", "src/other.ts"]
    );
  });
});
