import * as assert from "assert";
import * as path from "path";
import { StagingCoordinator } from "../stagingCoordinator";

type Cleanup = {
  cleanupHiddenDirectoryAdditions(
    repository: unknown,
    directory: string,
    visibleAdded: unknown[]
  ): Promise<void>;
};

suite("Staging Directory Status Tests", () => {
  test("scopes cleanup status to staged directory", async () => {
    const disposable = { dispose() {} };
    const manager = {
      repositories: [],
      onDidOpenRepository: () => disposable,
      onDidCloseRepository: () => disposable
    };
    const staging = new StagingCoordinator(manager as never);

    const root = path.resolve("working-copy");
    const directory = path.join(root, "new-folder");
    const hidden = path.join(directory, "hidden.txt");
    const relative = path.relative(root, directory);
    const hiddenRelative = path.join(relative, "hidden.txt");
    const execCalls: string[][] = [];
    const revertCalls: { paths: string[]; depth: string }[] = [];

    const repository = {
      workspaceRoot: root,
      repository: {
        removeAbsolutePath(target: string) {
          assert.equal(target, directory);
          return relative;
        },
        async exec(args: string[]) {
          execCalls.push(args);
          return {
            stdout: [
              '<?xml version="1.0" encoding="UTF-8"?>',
              "<status>",
              `  <target path="${relative}">`,
              `    <entry path="${hiddenRelative}">`,
              '      <wc-status item="added" props="none" revision="0" />',
              "    </entry>",
              "  </target>",
              "</status>"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }
      },
      async revert(paths: string[], depth: string) {
        revertCalls.push({ paths, depth });
      }
    };

    try {
      const cleanup = staging as unknown as Cleanup;
      await cleanup.cleanupHiddenDirectoryAdditions(repository, directory, []);
    } finally {
      staging.dispose();
    }

    assert.deepEqual(execCalls, [
      ["stat", "--xml", "--no-ignore", "--ignore-externals", relative]
    ]);
    assert.deepEqual(revertCalls, [{ paths: [hidden], depth: "empty" }]);
  });
});
