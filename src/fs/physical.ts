import * as physicalFs from "original-fs";

// Electron's original-fs callback API bypasses ASAR virtualization. Its
// promises property does not preserve that behavior on older VS Code/Electron
// hosts, so async helpers intentionally promisify the callback methods instead.
export { physicalFs };
