"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkSize, checkPackage } = require("./check-package-size.cjs");

test("budget accepts positive sizes including the exact limit", () => {
  assert.match(checkSize("bundle", 1, 10), /1\/10/);
  assert.match(checkSize("bundle", 10, 10), /10\/10/);
});

test("budget rejects empty, invalid, and oversized inputs", () => {
  for (const bytes of [0, -1, 11, NaN, Infinity, 1.5]) {
    assert.throws(() => checkSize("bundle", bytes, 10));
  }
  for (const limit of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => checkSize("bundle", 1, limit));
  }
});

test("package check requires both nonempty regular files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-package-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "out"));
  assert.throws(() => checkPackage(undefined, root), /Usage/);
  assert.throws(() => checkPackage("test.vsix", root), /ENOENT/);
  fs.writeFileSync(path.join(root, "out/extension.js"), "bundle");
  assert.throws(() => checkPackage("test.vsix", root), /ENOENT/);
  fs.writeFileSync(path.join(root, "test.vsix"), "");
  assert.throws(() => checkPackage("test.vsix", root), /expected/);
  fs.writeFileSync(path.join(root, "test.vsix"), "archive");
  assert.equal(checkPackage("test.vsix", root).length, 2);
  assert.throws(() => checkPackage("out", root), /not a regular file/);
});
