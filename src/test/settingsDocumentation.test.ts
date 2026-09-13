import * as assert from "assert";
import { readFileSync } from "node:fs";
import { resolve } from "path";
import {
  generateSettingsSection,
  updateSettingsSection
} from "../tools/generateConfigSectionForReadme";

suite("Settings documentation and schema", () => {
  test("renders falsy defaults and enum choices without losing table structure", () => {
    const section = generateSettingsSection({
      "svn.flag": { description: "A | B\n<flag>", default: false },
      "svn.limit": { description: "Limit", default: 0 },
      "svn.path": { description: "Path", default: null },
      "svn.mode": { description: "Mode", default: "a", enum: ["a", "b"] }
    });
    assert.ok(section.includes("A &#124; B \\<flag\\> | `false`"));
    assert.ok(section.includes("| `0` |"));
    assert.ok(section.includes("| `null` |"));
    assert.ok(section.includes('Allowed values: `"a"`, `"b"`.'));
    assert.strictEqual(section.split("\n").length, 6);
  });

  test("updates only the marked section, preserving line endings and detecting drift", () => {
    for (const newline of ["\n", "\r\n"]) {
      const prefix = `User text${newline}<!--begin-settings-->`;
      const suffix = `<!--end-settings-->${newline}More user text`;
      const old = `${prefix}${newline}stale${newline}${suffix}`;
      const updated = updateSettingsSection(old, "first\nsecond");
      assert.strictEqual(
        updated,
        `${prefix}${newline}first${newline}second${newline}${suffix}`
      );
      assert.notStrictEqual(updated, old);
      assert.strictEqual(
        updateSettingsSection(updated, "first\nsecond"),
        updated
      );
    }
    for (const invalid of [
      "",
      "<!--end-settings--><!--begin-settings-->",
      "<!--begin-settings--><!--begin-settings--><!--end-settings-->"
    ]) {
      assert.throws(() => updateSettingsSection(invalid, "new"), /marker pair/);
    }
  });

  test("all manifest defaults match their declared types and string-list schemas", () => {
    const properties = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8")
    ).contributes.configuration.properties;
    const validTypes = [
      "string",
      "number",
      "integer",
      "boolean",
      "array",
      "object",
      "null"
    ];
    for (const [key, raw] of Object.entries(properties)) {
      const prop = raw as {
        type: string | string[];
        default: unknown;
        items?: { type: string };
        enum?: unknown[];
      };
      const types = Array.isArray(prop.type) ? prop.type : [prop.type];
      assert.ok(
        types.every(type => validTypes.includes(type)),
        key
      );
      const value = prop.default;
      const type =
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      assert.ok(
        types.includes(type) ||
          (types.includes("integer") && Number.isInteger(value)),
        key
      );
      if (types.includes("array")) {
        assert.strictEqual(prop.items?.type, "string", key);
        if (Array.isArray(value))
          assert.ok(
            value.every(item => typeof item === "string"),
            key
          );
      }
      if (prop.enum) assert.ok(prop.enum.includes(value), key);
    }
  });
});
