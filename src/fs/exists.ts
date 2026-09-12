import { physicalFs } from "./physical";

export function exists(path: string): Promise<boolean> {
  return new Promise(resolve => {
    physicalFs.access(path, error => resolve(!error));
  });
}
