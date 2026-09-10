import * as assert from "assert";
import { IFileStatus, Status } from "../common/types";
import {
  isTargetCoveredByTargets,
  isTargetInWorkspace,
  mergeStatuses
} from "../incrementalStatus";

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

  test("scopes targets to one workspace folder", () => {
    const workspaceRoot = "/wc/client";

    assert.equal(
      isTargetInWorkspace(workspaceRoot, "/wc/client/src/a.ts"),
      true
    );
    assert.equal(
      isTargetInWorkspace(workspaceRoot, "/wc/server/src/b.ts"),
      false
    );
    assert.equal(isTargetInWorkspace(workspaceRoot, "../server/src/b.ts"), false);
  });

  test("does not merge sibling workspace statuses", () => {
    const current = [status("src/a.ts", Status.MODIFIED)];
    const updated = [status("../server/src/b.ts", Status.MODIFIED)];

    const result = mergeStatuses(
      "/wc/client",
      current,
      ["/wc/server/src/b.ts"],
      updated
    );

    assert.deepEqual(
      result.map(item => item.path),
      ["src/a.ts"]
    );
  });

  test("isolates Windows workspace folders from the same working copy", () => {
    const programming = "D:\\WOT\\programming";
    const bigworldScripts = "D:\\WOT\\game\\res\\bigworld\\scripts";
    const avatarFilter =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";
    const siblingRelative =
      "..\\..\\..\\..\\programming\\bigworld_client\\client\\avatar_filter.cpp";

    assert.equal(isTargetInWorkspace(programming, avatarFilter), true);
    assert.equal(isTargetInWorkspace(bigworldScripts, avatarFilter), false);
    assert.equal(isTargetInWorkspace(bigworldScripts, siblingRelative), false);
  });

  test("drops an already polluted sibling status from a workspace snapshot", () => {
    const workspaceRoot = "D:\\WOT\\game\\res\\bigworld\\scripts";
    const current = [
      status(
        "..\\..\\..\\..\\programming\\bigworld_client\\client\\avatar_filter.cpp",
        Status.MODIFIED
      ),
      status("server\\base.py", Status.MODIFIED)
    ];

    const result = mergeStatuses(
      workspaceRoot,
      current,
      ["server\\base.py"],
      [status("server\\base.py", Status.MODIFIED)]
    );

    assert.deepEqual(
      result.map(item => item.path),
      ["server\\base.py"]
    );
  });

  test("recognizes filesystem echoes from an active targeted operation", () => {
    const workspaceRoot = "D:\\WOT\\programming";
    const avatarFilter =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";
    const otherFile =
      "D:\\WOT\\programming\\bigworld_client\\client\\boids_filter.cpp";

    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, avatarFilter, [avatarFilter]),
      true
    );
    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, otherFile, [avatarFilter]),
      false
    );
  });

  test("recognizes filesystem echoes below a targeted directory", () => {
    const workspaceRoot = "D:\\WOT\\programming";
    const directory = "D:\\WOT\\programming\\bigworld_client\\client";
    const file =
      "D:\\WOT\\programming\\bigworld_client\\client\\avatar_filter.cpp";

    assert.equal(
      isTargetCoveredByTargets(workspaceRoot, file, [directory]),
      true
    );
  });
});
