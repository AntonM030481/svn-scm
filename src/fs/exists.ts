import { physicalFsPromises } from "./physical";

export async function exists(path: string): Promise<boolean> {
  try {
    await physicalFsPromises.access(path);
    return true;
  } catch {
    return false;
  }
}
