import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "os";
import * as path from "path";
import { Uri } from "vscode";
import { isWorkspaceFileChange } from "../watchers/repositoryFilesWatcher";

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
});
