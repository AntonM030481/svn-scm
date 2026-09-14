import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import { ThemeIcon, Uri } from "vscode";
import { Status } from "../common/types";
import { Resource } from "../resource";

suite("Resource Tests", () => {
  test("Unversioned directory uses folder decoration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-scm-resource-"));
    const directory = path.join(root, "folder");
    const file = path.join(root, "file.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, "test");

    try {
      const directoryResource = new Resource(
        Uri.file(directory),
        Status.UNVERSIONED
      );
      const fileResource = new Resource(Uri.file(file), Status.UNVERSIONED);

      assert.strictEqual(
        directoryResource.decorations.light?.iconPath,
        ThemeIcon.Folder
      );
      assert.strictEqual(
        directoryResource.decorations.dark?.iconPath,
        ThemeIcon.Folder
      );
      assert.notStrictEqual(
        fileResource.decorations.light?.iconPath,
        ThemeIcon.Folder
      );
      assert.notStrictEqual(
        fileResource.decorations.dark?.iconPath,
        ThemeIcon.Folder
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
