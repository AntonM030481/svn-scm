import * as nodeFs from "node:fs";

declare const __webpack_require__: NodeRequire;
declare const __non_webpack_require__: NodeRequire;

// Electron patches node:fs so .asar archives behave like directories. SVN
// must see working-copy .asar files as ordinary files, so prefer Electron's
// unpatched filesystem. New Electron exposes node:original-fs; older versions
// use original-fs. Plain Node hosts provide neither, so fall back to node:fs.
const runtimeRequire: NodeRequire =
  typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

export const physicalFs: typeof nodeFs = (() => {
  for (const moduleName of ["node:original-fs", "original-fs"]) {
    try {
      return runtimeRequire(moduleName) as typeof nodeFs;
    } catch {
      // Try the next Electron module name.
    }
  }

  return nodeFs;
})();

export const physicalFsPromises = physicalFs.promises;
