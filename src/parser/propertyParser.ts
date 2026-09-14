import * as xml2js from "xml2js";

interface PropertyNode {
  _?: string;
  encoding?: string;
}

export async function parseSvnPropertyValue(content: string): Promise<string> {
  const parsed = await xml2js.parseStringPromise(content, {
    mergeAttrs: true,
    explicitRoot: false,
    explicitArray: false
  });
  const property = parsed?.target?.property as
    PropertyNode | string | undefined;

  if (typeof property === "string") {
    return property;
  }
  const value = property?._ ?? "";
  if (property?.encoding === undefined) {
    return value;
  }
  if (property.encoding !== "base64") {
    throw new Error(`Unsupported SVN property encoding: ${property.encoding}`);
  }
  return Buffer.from(value, "base64").toString("utf8");
}
