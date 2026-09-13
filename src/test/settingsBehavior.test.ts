import * as assert from "assert";
import { ConfigurationTarget, Uri, window, workspace } from "vscode";
import { Resolved } from "../commands/resolved";
import { getBranchName } from "../helpers/branch";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";

suite("Published setting behavior", () => {
  const keys = [
    "conflicts.autoResolve",
    "layout.tagsRegex",
    "layout.tagRegexName"
  ];
  const saved = new Map<string, unknown>();
  let originalWarning: typeof window.showWarningMessage;

  setup(() => {
    originalWarning = window.showWarningMessage;
    for (const key of keys) {
      saved.set(
        key,
        workspace.getConfiguration("svn").inspect(key)?.globalValue
      );
    }
  });

  teardown(async () => {
    window.showWarningMessage = originalWarning;
    for (const key of keys) {
      await workspace
        .getConfiguration("svn")
        .update(key, saved.get(key), ConfigurationTarget.Global);
    }
    saved.clear();
  });

  async function set(key: string, value: unknown) {
    await workspace
      .getConfiguration("svn")
      .update(key, value, ConfigurationTarget.Global);
    assert.deepStrictEqual(configuration.get(key), value);
  }

  for (const scenario of [
    { auto: true, answer: undefined, prompts: 0, resolves: 1 },
    { auto: false, answer: "Yes", prompts: 1, resolves: 1 },
    { auto: false, answer: "No", prompts: 1, resolves: 0 },
    { auto: false, answer: undefined, prompts: 1, resolves: 0 }
  ]) {
    test(`autoResolve=${scenario.auto}, answer=${scenario.answer} preserves confirmation semantics`, async () => {
      await set("conflicts.autoResolve", scenario.auto);
      let prompts = 0;
      const resolutions: Array<{ files: string[]; action: string }> = [];
      window.showWarningMessage = (async () => {
        prompts++;
        return scenario.answer;
      }) as typeof window.showWarningMessage;
      // Exercise the real command with only repository routing and the modal stubbed.
      // Do not register a second svn.resolved command in the active extension host.
      const command = Object.create(Resolved.prototype) as Resolved;
      const uri = Uri.file("/working-copy/conflicted.txt");
      (command as any).runByRepository = async (
        uris: Uri[],
        action: (repository: Repository, resources: Uri[]) => Promise<void>
      ) => {
        await action(
          {
            resolve: async (files: string[], accept: string) => {
              resolutions.push({ files, action: accept });
            }
          } as unknown as Repository,
          uris
        );
      };
      try {
        await command.execute(uri);
        assert.strictEqual(prompts, scenario.prompts);
        assert.strictEqual(resolutions.length, scenario.resolves);
        if (scenario.resolves) {
          assert.deepStrictEqual(resolutions[0], {
            files: [uri.fsPath],
            action: "working"
          });
        }
      } finally {
        command.dispose();
      }
    });
  }

  test("tagRegexName selects the configured user capture group", async () => {
    await set("layout.tagsRegex", "tags/([^/]+)/([^/]+)");
    await set("layout.tagRegexName", 2);
    assert.deepStrictEqual(
      getBranchName("https://example.test/repo/tags/category/release"),
      {
        name: "release",
        path: "tags/category/release"
      }
    );
    await set("layout.tagRegexName", 1);
    assert.strictEqual(
      getBranchName("tags/category/release")?.name,
      "category"
    );
    await set("layout.tagsRegex", null);
    assert.strictEqual(getBranchName("tags/category/release"), undefined);
  });
});
