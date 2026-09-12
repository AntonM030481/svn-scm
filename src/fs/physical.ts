import * as nodeFs from "node:fs";

declare const __webpack_require__: NodeRequire;
declare const __non_webpack_require__: NodeRequire;

type ElectronProcess = NodeJS.Process & { noAsar?: boolean };

// Electron patches node:fs so .asar archives behave like directories. SVN
// must see working-copy .asar files as ordinary files. Modern Electron exposes
// node:original-fs; older extension hosts fall back to scoped process.noAsar.
const runtimeRequire: NodeRequire =
  typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

function loadOriginalFs(): typeof nodeFs | undefined {
  try {
    return runtimeRequire("node:original-fs") as typeof nodeFs;
  } catch {
    return undefined;
  }
}

function withoutAsar<T>(operation: () => T): T {
  const electronProcess = process as ElectronProcess;
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;

  try {
    return operation();
  } finally {
    if (previous === undefined) {
      delete electronProcess.noAsar;
    } else {
      electronProcess.noAsar = previous;
    }
  }
}

function wrapWithoutAsar<T extends object>(target: T): T {
  const wrappers = new Map<PropertyKey, unknown>();

  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      let wrapped = wrappers.get(property);
      if (!wrapped) {
        wrapped = (...args: unknown[]) =>
          withoutAsar(() => Reflect.apply(value, current, args));
        wrappers.set(property, wrapped);
      }

      return wrapped;
    }
  });
}

const originalFs = loadOriginalFs();

export const physicalFs: typeof nodeFs =
  originalFs ?? wrapWithoutAsar(nodeFs);

export const physicalFsPromises =
  originalFs?.promises ?? wrapWithoutAsar(nodeFs.promises);
