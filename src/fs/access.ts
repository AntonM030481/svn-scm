import { physicalFs } from "./physical";

export function access(
  path: string,
  mode: number | undefined
): Promise<boolean> {
  return new Promise(resolve => {
    physicalFs.access(path, mode, error => resolve(!error));
  });
}
