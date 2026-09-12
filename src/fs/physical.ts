import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

// Electron patches node:fs so .asar archives behave like directories. SVN
// must see working-copy .asar files as ordinary files, so prefer Electron's
// built-in original-fs. Plain Node hosts do not provide it, hence fallback.
const runtimeRequire = createRequire(__filename);

export const physicalFs: typeof nodeFs = (() => {
  try {
    return runtimeRequire("original-fs") as typeof nodeFs;
  } catch {
    return nodeFs;
  }
})();

export const physicalFsPromises = physicalFs.promises;
