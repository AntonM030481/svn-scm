import * as assert from "assert";
import { commands, Uri } from "vscode";
import { Command } from "../commands/command";
import { Status } from "../common/types";
import { Repository } from "../repository";
import { Resource } from "../resource";
import IncomingChangesNode from "../treeView/nodes/incomingChangesNode";
import { deduplicateUnversionedResources } from "../unversionedDirectoryContents";
import { normalizePath, pathEquals } from "../util";

class ValidationCommand extends Command {
  constructor() {
    super("svn.test.pathIdentityValidation");
  }

  public execute(): void {}

  public validate(resources: Resource[]): Promise<Resource[]> {
    return this.getResourceStates(resources, true);
  }
}

suite("Local path identity", () => {
  test("path equality delegates to the canonical local-path normalization", function () {
    assert.equal(pathEquals("a/b", "a\\b"), true);

    if (process.platform !== "win32") {
      assert.equal(pathEquals("/Work/File.txt", "/work/file.txt"), false);
      return;
    }

    assert.equal(
      pathEquals("C:/Work/Folder/File.txt", "c:\\work\\folder\\file.TXT"),
      true
    );
    assert.equal(
      pathEquals(
        "\\\\SERVER\\Share\\Folder\\File.txt",
        "\\\\server\\share\\folder\\FILE.TXT"
      ),
      true
    );
    assert.equal(
      normalizePath("\\\\SERVER\\Share\\Folder"),
      normalizePath("\\\\server\\share\\folder")
    );
  });

  test("repository resource lookup accepts Windows casing variants", function () {
    if (process.platform !== "win32") this.skip();

    const resource = new Resource(
      Uri.file("C:\\Work\\Project\\File.txt"),
      Status.MODIFIED
    );
    const repository = Object.create(Repository.prototype) as any;
    repository.changes = { resourceStates: [resource] };
    repository.conflicts = { resourceStates: [] };
    repository.unversioned = { resourceStates: [] };
    repository.staged = undefined;
    repository.changelists = new Map();

    assert.strictEqual(
      repository.getResourceFromFile(
        Uri.file("c:\\work\\project\\FILE.TXT")
      ),
      resource
    );
  });

  test("incoming changes deduplicate Windows casing variants", async function () {
    if (process.platform !== "win32") this.skip();

    const first = new Resource(
      Uri.file("C:\\Work\\Project\\Remote.txt"),
      Status.MODIFIED,
      undefined,
      undefined,
      true
    );
    const second = new Resource(
      Uri.file("c:\\work\\project\\REMOTE.TXT"),
      Status.MODIFIED,
      undefined,
      undefined,
      true
    );
    const node = new IncomingChangesNode({
      scopes: [
        { remoteChanges: { resourceStates: [first] } },
        { remoteChanges: { resourceStates: [second] } }
      ]
    } as any);

    assert.equal((await node.getChildren()).length, 1);
  });

  test("expanded unversioned resources deduplicate Windows casing variants", function () {
    if (process.platform !== "win32") this.skip();

    const first = new Resource(
      Uri.file("C:\\Work\\Project\\New.txt"),
      Status.UNVERSIONED
    );
    const second = new Resource(
      Uri.file("c:\\work\\project\\NEW.TXT"),
      Status.UNVERSIONED
    );

    assert.deepStrictEqual(
      deduplicateUnversionedResources([first, second]),
      [second]
    );
  });

  test("conflict save matching accepts Windows casing variants", async function () {
    if (process.platform !== "win32") this.skip();

    const conflict = new Resource(
      Uri.file("C:\\Work\\Project\\Conflict.txt"),
      Status.CONFLICTED
    );
    const repository = Object.create(Repository.prototype) as any;
    repository.hasLiveStatus = true;
    repository.disposed = false;
    repository.conflicts = { resourceStates: [conflict] };

    const originalExecute = commands.executeCommand;
    let resolved: Uri | undefined;
    (commands as any).executeCommand = async (
      command: string,
      uri: Uri
    ) => {
      if (command === "svn.resolved") resolved = uri;
    };

    try {
      repository.onDidSaveTextDocument({
        uri: Uri.file("c:\\work\\project\\CONFLICT.TXT"),
        getText: () => "resolved contents"
      });
      await Promise.resolve();

      assert.strictEqual(resolved, conflict.resourceUri);
    } finally {
      commands.executeCommand = originalExecute;
    }
  });

  test("mutation validation accepts remote and rename casing changes", async function () {
    if (process.platform !== "win32") this.skip();

    const before = new Resource(
      Uri.file("C:\\Work\\Project\\File.txt"),
      Status.ADDED,
      Uri.file("C:\\Work\\Project\\Old.txt"),
      undefined,
      true
    );
    const after = new Resource(
      Uri.file("c:\\work\\project\\FILE.TXT"),
      Status.ADDED,
      Uri.file("c:\\work\\project\\OLD.TXT"),
      undefined,
      true
    );
    const repository = {
      ensureStatus: async () => undefined,
      isPreviewResource: () => false,
      remoteChanges: { resourceStates: [after] }
    };
    const manager = { getRepository: () => repository };
    const originalExecute = commands.executeCommand;
    (commands as any).executeCommand = async (command: string) =>
      command === "svn.getSourceControlManager" ? manager : undefined;

    const command = new ValidationCommand();
    try {
      assert.deepStrictEqual(await command.validate([before]), [after]);
    } finally {
      command.dispose();
      commands.executeCommand = originalExecute;
    }
  });
});
