import * as nodeFs from "node:fs";

// Electron patches node:fs so .asar archives behave like directories. SVN
// must see working-copy .asar files as ordinary files, so prefer Electron's
// built-in original-fs. Webpack's runtime require preserves that Electron
// module lookup; createRequire() does not on older VS Code extension hosts.
const runtimeRequire: NodeRequire =
  typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

export const physicalFs: typeof nodeFs = (() => {
  try {
    return runtimeRequire("original-fs") as typeof nodeFs;
  } catch {
    return nodeFs;
  }
})();

export const physicalFsPromises = physicalFs.promises;
