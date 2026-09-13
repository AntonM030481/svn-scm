import * as assert from "assert";
import { ThemeIcon, Uri } from "vscode";
import { configuration } from "../helpers/configuration";
import { getCommitIcon } from "../historyView/common";

suite("History avatar settings", () => {
  let originalGet: typeof configuration.get;
  let enabled: boolean;
  let template: string;

  setup(() => {
    originalGet = configuration.get;
    enabled = true;
    template = "https://example.test/<AUTHOR>/<AUTHOR_MD5>?s=<SIZE>";
    configuration.get = <T>(key: string, fallback?: T): T =>
      (key === "gravatars.enabled"
        ? enabled
        : key === "gravatar.icon_url"
          ? template
          : fallback) as T;
  });

  teardown(() => {
    configuration.get = originalGet;
  });

  const icon = (author: string, size?: number) => {
    const result = getCommitIcon(author, size);
    assert.ok(result instanceof Uri);
    // Compare substituted components, not VS Code's percent-encoded rendering.
    return result.toString(true);
  };

  test("same author uses the requested size, including default and repeated calls", () => {
    const base =
      "https://example.test/alice/6384e2b2184bcbf58eccf10ca7a6563c?s=";
    assert.equal(icon("alice"), base + "16");
    assert.equal(icon("alice", 32), base + "32");
    assert.equal(icon("alice", 32), base + "32");
    assert.equal(icon("alice"), base + "16");
  });

  test("template changes apply on the next render and authors remain distinct", () => {
    icon("alice");
    template = "https://other.test/<AUTHOR>?size=<SIZE>";
    assert.equal(icon("alice"), "https://other.test/alice?size=16");
    assert.equal(icon("bob"), "https://other.test/bob?size=16");
    template = "https://other.test/<AUTHOR_MD5>";
    assert.equal(
      icon("bob"),
      "https://other.test/9f9d51bc70ef21ca5c14f307980a29d8"
    );
  });

  test("disabled or absent-author icons retain the native fallback", () => {
    icon("alice");
    enabled = false;
    const disabled = getCommitIcon("alice");
    assert.ok(disabled instanceof ThemeIcon);
    assert.equal(disabled.id, "git-commit");
    template = "https://other.test/<AUTHOR>/<SIZE>";
    enabled = true;
    assert.equal(icon("alice", 24), "https://other.test/alice/24");
    const missing = getCommitIcon(undefined as unknown as string);
    assert.ok(missing instanceof ThemeIcon);
    assert.equal(missing.id, "git-commit");
  });
});
