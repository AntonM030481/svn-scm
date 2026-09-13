import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "os";
import * as path from "path";
import { FSWatcher } from "node:fs";
import { Uri } from "vscode";
import {
  isWorkspaceFileChange,
  RepositoryFilesWatcher,
  resolveNativeWatcherPath
} from "../watchers/repositoryFilesWatcher";
import { timeout } from "../util";

suite("Repository Files Watcher Tests", () => {
  test("ignores directory changes and keeps file changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-scm-watcher-"));
    const directory = path.join(root, "programming");
    const file = path.join(root, "canvas_app.cpp");

    fs.mkdirSync(directory);
    fs.writeFileSync(file, "test");

    try {
      assert.equal(isWorkspaceFileChange(Uri.file(directory)), false);
      assert.equal(isWorkspaceFileChange(Uri.file(file)), true);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(directory);
      fs.rmdirSync(root);
    }
  });

  test("resolves native watcher filenames below SVN metadata", () => {
    const metadataRoot = path.join(
      path.parse(process.cwd()).root,
      "wc",
      ".svn"
    );

    assert.equal(
      resolveNativeWatcherPath(metadataRoot, "wc.db"),
      path.join(metadataRoot, "wc.db")
    );
    assert.equal(
      resolveNativeWatcherPath(metadataRoot, Buffer.from("tmp/state")),
      path.join(metadataRoot, "tmp", "state")
    );
    assert.equal(resolveNativeWatcherPath(metadataRoot, null), undefined);
  });

  test("closes the native watcher and ignores later callbacks", async () => {
    let callback:
      ((event: string, filename: string | Buffer | null) => void) | undefined;
    let closeCalls = 0;
    const fakeWatcher = {
      on: () => fakeWatcher,
      close: () => {
        closeCalls += 1;
      }
    } as unknown as FSWatcher;
    const watcher = new RepositoryFilesWatcher(
      path.join(os.tmpdir(), "outside-workspace-working-copy"),
      (_metadataRoot, listener) => {
        callback = listener;
        return fakeWatcher;
      }
    );
    let events = 0;
    watcher.onDidSvnChange(() => {
      events += 1;
    });

    watcher.dispose();
    watcher.dispose();
    callback?.("change", "wc.db");
    await timeout(1100);

    assert.equal(closeCalls, 1);
    assert.equal(events, 0);
  });
});
