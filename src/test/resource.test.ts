import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import { ThemeIcon, Uri } from "vscode";
import { IFileStatus, PropStatus, Status } from "../common/types";
import { Resource } from "../resource";
import { refreshUnversionedDirectoryKinds } from "../resourceKinds";

suite("Resource Tests", () => {
  test("Unversioned directory uses folder decoration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-scm-resource-"));
    const directory = path.join(root, "folder");
    const file = path.join(root, "file.txt");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, "test");

    const statuses: IFileStatus[] = [
      {
        path: "folder",
        status: Status.UNVERSIONED,
        props: PropStatus.NONE,
        wcStatus: { locked: false, switched: false }
      },
      {
        path: "file.txt",
        status: Status.UNVERSIONED,
        props: PropStatus.NONE,
        wcStatus: { locked: false, switched: false }
      }
    ];

    try {
      await refreshUnversionedDirectoryKinds(root, statuses);

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
