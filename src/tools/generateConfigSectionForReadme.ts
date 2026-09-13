import { readFileSync, writeFileSync } from "node:fs";
import { join } from "path";

export interface SettingDefinition {
  description: string;
  default: unknown;
  enum?: unknown[];
}

export function generateSettingsSection(
  properties: Record<string, SettingDefinition>
): string {
  const escape = (value: string) =>
    value
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "&#124;")
      .replace(/`/g, "&#96;");
  const rows = Object.entries(properties).map(([key, prop]) => {
    const description = escape(prop.description).replace(/([*<>])/g, "\\$1");
    const choices = prop.enum
      ? ` Allowed values: ${prop.enum.map(value => `\`${escape(JSON.stringify(value))}\``).join(", ")}.`
      : "";
    return `| \`${key}\` | ${description}${choices} | \`${escape(JSON.stringify(prop.default))}\` |`;
  });
  return [
    "| Config | Description | Default |",
    "| --- | --- | --- |",
    ...rows
  ].join("\n");
}

export function updateSettingsSection(readme: string, section: string): string {
  const begin = "<!--begin-settings-->";
  const end = "<!--end-settings-->";
  const start = readme.indexOf(begin);
  const finish = readme.indexOf(end);
  if (
    start < 0 ||
    finish < start ||
    readme.indexOf(begin, start + begin.length) !== -1 ||
    readme.indexOf(end, finish + end.length) !== -1
  ) {
    throw new Error(
      "README must contain exactly one ordered settings marker pair"
    );
  }
  const newline = readme.includes("\r\n") ? "\r\n" : "\n";
  return (
    readme.slice(0, start + begin.length) +
    newline +
    section.replace(/\r?\n/g, newline) +
    newline +
    readme.slice(finish)
  );
}

if (require.main === module) {
  const properties = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ).contributes.configuration.properties;
  const section = generateSettingsSection(properties);
  const mode = process.argv[2];
  if (mode === "--write" || mode === "--check") {
    const readmePath = join(process.cwd(), "README.md");
    const readme = readFileSync(readmePath, "utf8");
    const updated = updateSettingsSection(readme, section);
    if (mode === "--write") {
      writeFileSync(readmePath, updated);
    } else if (readme !== updated) {
      console.error("README settings are stale. Run yarn tools:genReadme.");
      process.exitCode = 1;
    }
  } else if (mode === undefined) {
    console.log(section);
  } else {
    throw new Error(
      "Use --write or --check, or omit the option to print the table"
    );
  }
}
