import * as xml2js from "xml2js";
import { ISvnInfo, ISvnTextConflictInputs } from "../common/types";
import { camelcase } from "../util";

export async function parseInfoXml(content: string): Promise<ISvnInfo> {
  return new Promise<ISvnInfo>((resolve, reject) => {
    xml2js.parseString(
      content,
      {
        mergeAttrs: true,
        explicitRoot: false,
        explicitArray: false,
        attrNameProcessors: [camelcase],
        tagNameProcessors: [camelcase]
      },
      (err, result) => {
        if (err || typeof result.entry === "undefined") {
          reject();
        }

        resolve(result.entry);
      }
    );
  });
}

export function getTextConflictInputs(
  info: ISvnInfo
): ISvnTextConflictInputs | undefined {
  const conflicts = info.conflict
    ? Array.isArray(info.conflict)
      ? info.conflict
      : [info.conflict]
    : [];
  const conflict = conflicts.find(value => value.type === "text");

  if (
    !conflict?.prevBaseFile ||
    !conflict.prevWcFile ||
    !conflict.curBaseFile
  ) {
    return undefined;
  }

  return {
    base: conflict.prevBaseFile,
    current: conflict.prevWcFile,
    incoming: conflict.curBaseFile
  };
}
