import * as nodeFs from "node:fs";

declare const __webpack_require__: NodeRequire;
declare const __non_webpack_require__: NodeRequire;

// Electron patches node:fs so .asar archives behave like directories. SVN
// must see working-copy .asar files as ordinary files. node:original-fs is
// Electron's pristine filesystem; plain Node does not provide it, so tests and
// tooling fall back to node:fs.
const runtimeRequire =
  typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

export const physicalFs: typeof nodeFs = (() => {
  try {
    return runtimeRequire("node:original-fs") as typeof nodeFs;
  } catch {
    return nodeFs;
  }
})();
