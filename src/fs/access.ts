import { physicalFsPromises } from "./physical";

export async function access(
  path: string,
  mode: number | undefined
): Promise<boolean> {
  try {
    await physicalFsPromises.access(path, mode);
    return true;
  } catch {
    return false;
  }
}
