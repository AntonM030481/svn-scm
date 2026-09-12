import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPackage } from "@electron/asar";
import { readdir, stat } from "../fs";

suite("Physical filesystem ASAR handling", () => {
  test("treats .asar archives as physical files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-scm-asar-"));
    const source = path.join(root, "source");
    const archive = path.join(root, "fixture.asar");
    const renamed = path.join(root, "fixture-renamed.asar");

    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "payload.txt"), "payload");

    try {
      await createPackage(source, archive);

      const archiveStat = await stat(archive);
      assert.equal(archiveStat.isFile(), true);
      assert.equal(archiveStat.isDirectory(), false);

      await assert.rejects(
        () => readdir(archive),
        (error: NodeJS.ErrnoException) => error.code === "ENOTDIR"
      );

      fs.renameSync(archive, renamed);
      assert.equal(fs.statSync(renamed).isFile(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
