"use strict";

const { readFileSync } = require("node:fs");
const path = require("node:path");

const releaseVersion =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function extractReleaseNotes(changelog, version) {
  if (typeof version !== "string" || !releaseVersion.test(version)) {
    throw new Error("Expected a release version without the v tag prefix");
  }

  const lines = changelog.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  let fence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }

    const heading = /^ {0,3}#{1,6}[ \t]+\[([^\]]+)\](?=[ \t(]|$)/.exec(line);
    if (!heading) continue;
    const label = heading[1];
    if (!releaseVersion.test(label) && label !== "Unreleased") continue;

    if (start !== -1) {
      end = index;
      break;
    }
    // Compare literally: version dots and build metadata are not a regex.
    if (label === version) start = index + 1;
  }

  if (start === -1)
    throw new Error(`Release ${version} not found in changelog`);
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  if (start === end) throw new Error(`Release ${version} has empty notes`);
  return `${lines.slice(start, end).join("\n")}\n`;
}

if (require.main === module) {
  try {
    const [version, changelog = path.resolve(__dirname, "../CHANGELOG.md")] =
      process.argv.slice(2);
    if (!version || process.argv.length > 4) {
      throw new Error(
        "Usage: node scripts/release-notes.cjs <version> [changelog]"
      );
    }
    process.stdout.write(
      extractReleaseNotes(readFileSync(changelog, "utf8"), version)
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractReleaseNotes };
