import * as path from "path";

export const STAGING_CHANGELIST_PREFIX = "__svn_scm_staged__";
const ORIGINAL_CHANGELIST_MARKER = ":c:";
const UNVERSIONED_MARKER = ":u";
const DIRECTORY_ROOT_MARKER = ":d:";

export interface StagingChangelistMetadata {
  originalChangelist?: string;
  wasUnversioned: boolean;
  createdDirectoryRelativeRoot?: string;
}

export function normalizeWorkingCopyRoot(root: string): string {
  let normalized = path.resolve(root).replace(/\\/g, "/");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized.replace(/\/$/, "");
}

export function createStagingChangelist(
  originalChangelist?: string,
  wasUnversioned: boolean = false,
  createdDirectoryRelativeRoot?: string
): string {
  if (wasUnversioned) {
    if (createdDirectoryRelativeRoot) {
      const encodedRoot = Buffer.from(
        createdDirectoryRelativeRoot,
        "utf8"
      ).toString("hex");
      return `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}${DIRECTORY_ROOT_MARKER}${encodedRoot}`;
    }
    return `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}`;
  }

  if (!originalChangelist) {
    return STAGING_CHANGELIST_PREFIX;
  }

  const encoded = Buffer.from(originalChangelist, "utf8").toString("hex");
  return `${STAGING_CHANGELIST_PREFIX}${ORIGINAL_CHANGELIST_MARKER}${encoded}`;
}

export function isStagingChangelist(name: string): boolean {
  return (
    name === STAGING_CHANGELIST_PREFIX ||
    name === `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}` ||
    name.startsWith(
      `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}${DIRECTORY_ROOT_MARKER}`
    ) ||
    name.startsWith(`${STAGING_CHANGELIST_PREFIX}${ORIGINAL_CHANGELIST_MARKER}`)
  );
}

export function parseStagingChangelist(
  name: string
): StagingChangelistMetadata | undefined {
  if (name === STAGING_CHANGELIST_PREFIX) {
    return { wasUnversioned: false };
  }

  if (name === `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}`) {
    return { wasUnversioned: true };
  }

  const directoryPrefix = `${STAGING_CHANGELIST_PREFIX}${UNVERSIONED_MARKER}${DIRECTORY_ROOT_MARKER}`;
  if (name.startsWith(directoryPrefix)) {
    const encodedRoot = name.slice(directoryPrefix.length);
    if (!encodedRoot || !/^(?:[0-9a-f]{2})+$/i.test(encodedRoot)) {
      return undefined;
    }
    return {
      wasUnversioned: true,
      createdDirectoryRelativeRoot: Buffer.from(encodedRoot, "hex").toString(
        "utf8"
      )
    };
  }

  const prefix = `${STAGING_CHANGELIST_PREFIX}${ORIGINAL_CHANGELIST_MARKER}`;
  if (!name.startsWith(prefix)) {
    return undefined;
  }

  const encoded = name.slice(prefix.length);
  if (!encoded || !/^(?:[0-9a-f]{2})+$/i.test(encoded)) {
    return undefined;
  }

  return {
    originalChangelist: Buffer.from(encoded, "hex").toString("utf8"),
    wasUnversioned: false
  };
}
