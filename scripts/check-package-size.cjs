"use strict";

const { statSync } = require("node:fs");
const path = require("node:path");
const budgets = require("../package-budgets.json");

function checkSize(label, bytes, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`${label}: budget must be a positive integer`);
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) {
    throw new Error(`${label}: ${bytes} bytes; expected 1..${limit}`);
  }
  return `${label}: ${bytes}/${limit} bytes`;
}

function checkPackage(vsix, root = path.resolve(__dirname, "..")) {
  if (!vsix) throw new Error("Usage: node scripts/check-package-size.cjs <vsix>");
  return [
    ["bundle", path.join(root, "out/extension.js"), budgets.bundleBytes],
    ["VSIX", path.resolve(root, vsix), budgets.vsixBytes]
  ].map(([label, file, limit]) => {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`${label}: not a regular file: ${file}`);
    return checkSize(label, stat.size, limit);
  });
}

if (require.main === module) {
  try {
    console.log(checkPackage(process.argv[2]).join("\n"));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkSize, checkPackage };
