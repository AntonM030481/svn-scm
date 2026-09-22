import * as xml2js from "xml2js";
export interface SvnBlameLine {
  line: number;
  revision: string;
  author?: string;
  date?: string;
}

interface ParsedBlameEntry {
  lineNumber: string;
  commit?: {
    revision?: string;
    author?: string;
    date?: string;
  };
}

export async function parseBlameXml(content: string): Promise<SvnBlameLine[]> {
  return new Promise<SvnBlameLine[]>((resolve, reject) => {
    xml2js.parseString(
      content,
      {
        mergeAttrs: true,
        explicitRoot: false,
        explicitArray: false,
        attrNameProcessors: [name => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())],
        tagNameProcessors: [name => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())]
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const rawEntries = result?.target?.entry;
        const entries: ParsedBlameEntry[] = rawEntries
          ? Array.isArray(rawEntries)
            ? rawEntries
            : [rawEntries]
          : [];

        resolve(
          entries.map(entry => ({
            line: Number(entry.lineNumber),
            revision: entry.commit?.revision ?? "-",
            author: entry.commit?.author,
            date: entry.commit?.date
          }))
        );
      }
    );
  });
}
