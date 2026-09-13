"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractReleaseNotes } = require("./release-notes.cjs");

test("selects literal version from linked CRLF headings and preserves subsections", () => {
  const changelog = [
    "# [Unreleased]",
    "Upcoming",
    "",
    "# [2.19.0](https://example.test/compare/v2.18.0...v2.19.0) (2026-09-10)",
    "",
    "### Fixes",
    "",
    "* Correct routing",
    "",
    "## [2.18.0](https://example.test/previous)",
    "Old notes"
  ].join("\r\n");
  assert.equal(
    extractReleaseNotes(changelog, "2.19.0"),
    "### Fixes\n\n* Correct routing\n"
  );
});

test("version is not interpreted as a regex or a prefix", () => {
  const changelog =
    "# [2x19x0]\nWrong\n# [2.19.0-beta.1]\nBeta\n# [2.19.0]\nStable\n";
  assert.equal(extractReleaseNotes(changelog, "2.19.0"), "Stable\n");
  assert.throws(
    () => extractReleaseNotes("# [2x19x0]\nWrong", "2.19.0"),
    /not found/
  );
});

for (const next of [
  "2.19.0-rc.1",
  "2.18.0+build.2",
  "2.18.0-rc.1+build.2",
  "Unreleased"
]) {
  test(`stops before the next ${next} release heading`, () => {
    assert.equal(
      extractReleaseNotes(
        `# [2.19.0]\nStable\n\n## [${next}](https://example.test)\nOther\n`,
        "2.19.0"
      ),
      "Stable\n"
    );
  });
}

test("can select a prerelease with build metadata literally", () => {
  const changelog =
    "# [2.19.0-rc.1+build.2]\nCandidate\n# [2.19.0-rc.1+build.1]\nOlder\n";
  assert.equal(
    extractReleaseNotes(changelog, "2.19.0-rc.1+build.2"),
    "Candidate\n"
  );
});

test("rejects missing, empty and whitespace-only notes", () => {
  assert.throws(
    () => extractReleaseNotes("# [Unreleased]\nNext", "2.19.0"),
    /not found/
  );
  for (const content of [
    "# [2.19.0]",
    "# [2.19.0]\r\n \t\r\n",
    "# [2.19.0]\n\n# [2.18.0]\nOld"
  ]) {
    assert.throws(() => extractReleaseNotes(content, "2.19.0"), /empty notes/);
  }
  for (const version of [undefined, "", "v2.19.0", "2.19.0|.*"]) {
    assert.throws(
      () => extractReleaseNotes("", version),
      /Expected a release version/
    );
  }
});

test("ignores release-shaped headings inside fenced examples", () => {
  const changelog = [
    "```md",
    "# [2.19.0]",
    "Fake",
    "```",
    "# [2.19.0]",
    "Notes",
    "~~~~md",
    "# [2.18.0]",
    "~~~",
    "Still code",
    "~~~~",
    "End",
    "# [2.18.0]",
    "Old"
  ].join("\n");
  assert.equal(
    extractReleaseNotes(changelog, "2.19.0"),
    "Notes\n~~~~md\n# [2.18.0]\n~~~\nStill code\n~~~~\nEnd\n"
  );
});

test("preserves meaningful indentation and non-release bracket headings", () => {
  assert.equal(
    extractReleaseNotes(
      "# [2.19.0]\n\n    example()\n\n### [Security]\nDetails\n\n",
      "2.19.0"
    ),
    "    example()\n\n### [Security]\nDetails\n"
  );
});

test("CLI writes only notes on success and fails without stdout otherwise", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-release-notes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "CHANGELOG.md");
  fs.writeFileSync(file, "# [2.19.0]\nRelease notes\n");
  const run = args =>
    spawnSync(
      process.execPath,
      [path.join(__dirname, "release-notes.cjs"), ...args],
      { encoding: "utf8" }
    );
  const success = run(["2.19.0", file]);
  assert.equal(success.status, 0);
  assert.equal(success.stdout, "Release notes\n");
  assert.equal(success.stderr, "");
  for (const args of [
    [],
    ["2.18.0", file],
    ["2.19.0", path.join(root, "missing.md")],
    ["2.19.0", file, "extra"]
  ]) {
    const failure = run(args);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.notEqual(failure.stderr, "");
  }
});
