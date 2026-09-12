import * as assert from "assert";
import { ConfigurationTarget, workspace } from "vscode";
import { detectEncoding } from "../encoding";

const CP1251 = Buffer.from(
  "cff0e8e2e5f220ece8f02e20ddf2ee20f2e5f1f220eaeee4e8f0eee2eae82053756276657273696f6e2e20d0f3f1f1eae8e920f2e5eaf1f220e4eeebe6e5ed20eeeff0e5e4e5ebfff2fcf1ff20f1f2e0e1e8ebfcedee2e20cff0e8e2e5f220ece8f02e20ddf2ee20f2e5f1f220eaeee4e8f0eee2eae82053756276657273696f6e2e20d0f3f1f1eae8e920f2e5eaf1f220e4eeebe6e5ed20eeeff0e5e4e5ebfff2fcf1ff20f1f2e0e1e8ebfcedee2e20",
  "hex"
);

const KOI8_R = Buffer.from(
  "f0d2c9d7c5d420cdc9d22e20fcd4cf20d4c5d3d420cbcfc4c9d2cfd7cbc92053756276657273696f6e2e20f2d5d3d3cbc9ca20d4c5cbd3d420c4cfccd6c5ce20cfd0d2c5c4c5ccd1d4d8d3d120d3d4c1c2c9ccd8cecf2e20f0d2c9d7c5d420cdc9d22e20fcd4cf20d4c5d3d420cbcfc4c9d2cfd7cbc92053756276657273696f6e2e20f2d5d3d3cbc9ca20d4c5cbd3d420c4cfccd6c5ce20cfd0d2c5c4c5ccd1d4d8d3d120d3d4c1c2c9ccd8cecf2e20",
  "hex"
);

const CP866 = Buffer.from(
  "8fe0a8a2a5e220aca8e02e209de2ae20e2a5e1e220aaaea4a8e0aea2aaa82053756276657273696f6e2e2090e3e1e1aaa8a920e2a5aae1e220a4aeaba6a5ad20aeafe0a5a4a5abefe2ece1ef20e1e2a0a1a8abecadae2e208fe0a8a2a5e220aca8e02e209de2ae20e2a5e1e220aaaea4a8e0aea2aaa82053756276657273696f6e2e2090e3e1e1aaa8a920e2a5aae1e220a4aeaba6a5ad20aeafe0a5a4a5abefe2ece1ef20e1e2a0a1a8abecadae2e20",
  "hex"
);

suite("Encoding detection", () => {
  const configuration = workspace.getConfiguration("svn");
  let previousExperimentalValue: boolean | undefined;

  setup(async () => {
    previousExperimentalValue = configuration.inspect<boolean>(
      "experimental.detect_encoding"
    )?.globalValue;
    await configuration.update(
      "experimental.detect_encoding",
      false,
      ConfigurationTarget.Global
    );
  });

  teardown(async () => {
    await configuration.update(
      "experimental.detect_encoding",
      previousExperimentalValue,
      ConfigurationTarget.Global
    );
  });

  test("detects BOM encodings before statistical detection", () => {
    assert.strictEqual(
      detectEncoding(Buffer.from([0xfe, 0xff, 0, 65])),
      "utf16be"
    );
    assert.strictEqual(
      detectEncoding(Buffer.from([0xff, 0xfe, 65, 0])),
      "utf16le"
    );
    assert.strictEqual(
      detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 65])),
      "utf8"
    );
  });

  test("detects Windows-1251 Cyrillic text", () => {
    assert.strictEqual(detectEncoding(CP1251), "windows1251");
  });

  test("detects KOI8-R Cyrillic text", () => {
    assert.strictEqual(detectEncoding(KOI8_R), "koi8r");
  });

  test("maps IBM866 detection to iconv cp866", () => {
    assert.strictEqual(detectEncoding(CP866), "cp866");
  });

  test("ignores ASCII and UTF-8 guesses", () => {
    assert.strictEqual(detectEncoding(Buffer.from("plain ASCII text")), null);
    assert.strictEqual(
      detectEncoding(Buffer.from("Привет мир, обычный UTF-8 текст", "utf8")),
      null
    );
  });

  test("limits statistical detection to the first 64 KiB", () => {
    const asciiPrefix = Buffer.alloc(512 * 128, 0x41);
    assert.strictEqual(
      detectEncoding(Buffer.concat([asciiPrefix, CP1251])),
      null
    );
  });
});
