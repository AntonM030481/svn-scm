import * as assert from "assert";
import * as path from "path";
import { StagingCoordinator } from "../stagingCoordinator";

suite("Staging Directory Status Tests", () => {
  test(
    "hidden descendant cleanup scopes svn status to the staged directory",
    async () => {
      const disposables = { dispose() {} };
      const sourceControlManager = {
        repositories: [],
        onDidOpenRepository: () => disposables,
        onDidCloseRepository: () => disposables
      };
      const coordinator = new StagingCoordinator(sourceControlManager as never);

      const workspaceRoot = path.resolve("working-copy");
      const directory = path.join(workspaceRoot, "new-folder");
      const hidden = path.join(directory, "hidden.txt");
      const execCalls: string[][] = [];
      const revertCalls: Array<{ paths: string[]; depth: string }> = [];
      const relativeDirectory = path.relative(workspaceRoot, directory);
      const hiddenRelative = path.join(relativeDirectory, "hidden.txt");

      const repository = {
        workspaceRoot,
        repository: {
          removeAbsolutePath(target: string) {
            assert.equal(target, directory);
            return relativeDirectory;
          },
          async exec(args: string[]) {
            execCalls.push(args);
            return {
              stdout: [
                '<?xml version="1.0" encoding="UTF-8"?>',
                "<status>",
                `  <target path="${relativeDirectory}">`,
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
      const cleanup = coordinator as unknown as {
        cleanupHiddenDirectoryAdditions(
          repository: unknown,
          directory: string,
          visibleAdded: unknown[]
        ): Promise<void>;
      };

      try {
        await cleanup.cleanupHiddenDirectoryAdditions(
          repository,
          directory,
          []
        );
      } finally {
        coordinator.dispose();
      }

      assert.deepEqual(execCalls, [
        [
          "stat",
          "--xml",
          "--no-ignore",
          "--ignore-externals",
          relativeDirectory
        ]
      ]);
      assert.deepEqual(revertCalls, [{ paths: [hidden], depth: "empty" }]);
    }
  );
});
