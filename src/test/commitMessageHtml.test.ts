import * as assert from "assert";
import {
  createCommitMessageInitialState,
  getCommitMessageWebviewHtml
} from "../webview/commitMessageHtml";

suite("Commit message webview", () => {
  test("uses a nonce-based CSP without inline-script permission", () => {
    const html = getCommitMessageWebviewHtml({
      cspSource: "vscode-webview://test",
      nonce: "fixed-nonce",
      styleUri: "vscode-webview://test/commit-message.css"
    });

    assert.ok(html.includes("script-src 'nonce-fixed-nonce'"));
    assert.ok(html.includes('<script nonce="fixed-nonce">'));
    assert.ok(!html.includes("'unsafe-inline'"));
    assert.ok(html.includes('e.ctrlKey && e.key === "Enter"'));
  });

  test("keeps untrusted content out of generated HTML", () => {
    const attack = '</script><script id="injected">attack()</script>';
    const html = getCommitMessageWebviewHtml({
      cspSource: "vscode-webview://test",
      nonce: "fixed-nonce",
      styleUri: "vscode-webview://test/commit-message.css"
    });
    const paths = [`<&\"'>/${attack}`, "z-file"];
    const state = createCommitMessageInitialState(attack, paths);

    assert.ok(!html.includes(attack));
    assert.ok(!html.includes(paths[0]));
    assert.strictEqual(state.message, attack);
    assert.deepStrictEqual(state.filePaths, [...paths].sort());
    assert.deepStrictEqual(paths, [`<&\"'>/${attack}`, "z-file"]);
  });
});
