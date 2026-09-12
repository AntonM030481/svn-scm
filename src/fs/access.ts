import { access as fsAccess } from "node:fs/promises";

export async function access(
  path: string,
  mode: number | undefined
): Promise<boolean> {
  try {
    await fsAccess(path, mode);
    return true;
  } catch {
    return false;
  }
}
