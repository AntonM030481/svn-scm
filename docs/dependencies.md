# Dependencies

## Policy

The lockfile is authoritative and installs must use `yarn install --immutable`.
Dependabot proposes weekly patch and minor updates as a group. Major updates are
initiated manually (Dependabot ignores major updates) because this extension
runs inside VS Code's Electron and Node environment rather than an arbitrary
system Node.js process.

Do not document every transitive package here. `package.json` and `yarn.lock`
are the source of truth for exact versions.

## Compatibility anchors

| Dependency | Role and constraint |
| --- | --- |
| `@types/vscode` 1.86 | Defines the minimum supported VS Code API surface and matches `engines.vscode` |
| `@types/node` 18 | Models the Node runtime available in the minimum supported VS Code 1.86 host |
| Mocha 10 | Test runner compatible with the minimum-version integration environment |
| TypeScript | Strict source and test compilation; upgrades may expose new type errors |
| `@vscode/test-electron` | Downloads and launches selected VS Code versions for integration tests |
| webpack and `ts-loader` | Produce the single CommonJS extension bundle |
| `@vscode/vsce` | Builds and validates the distributable VSIX |
| ESLint, typescript-eslint, and Prettier | Define the static quality gate |

Runtime libraries are bundled into `out/extension.js`; `vscode` is the notable
external supplied by the host. The extension does not ship the SVN executable.

`SvnFinder` validates the local client (minimum SVN 1.6) and publishes a normalized
`major.minor.patch` version. Vendor suffixes such as SlikSVN build identifiers are
removed at this boundary. Discovery and other capability checks consume that
validated value rather than applying different rules to the raw version string.

## Updating dependencies

See the [2026-09-13 audit](dependency-audit-2026-09-13.md) for reproducible
commands, reviewed advisory IDs, compatible lockfile updates, and the explicit
Mocha tooling exception. Audit the entire graph: bundled runtime libraries also
live in `devDependencies`, so a production-only dependency audit is insufficient.

For routine patch or minor updates:

1. update the lockfile with Yarn;
2. inspect the resolved versions and release notes;
3. run `yarn check`, `yarn test:unit`, and the integration suite;
4. build a VSIX when bundling or packaging dependencies changed.

For major updates, review:

- the minimum VS Code and embedded Node compatibility;
- CommonJS and webpack compatibility;
- changes in lint, formatting, or TypeScript diagnostics;
- VSIX contents and bundle size;
- the full OS and VS Code CI matrix.

Keep `@types/vscode` pinned to the minimum supported API unless the extension's
`engines.vscode` requirement is intentionally raised. Do not upgrade
`@types/node` based only on the Node version used to run the build.

## Why the compatibility pins remain

Mocha 12 was tried during modernization and could not run in the VS Code 1.86
integration environment. Mocha 10 is therefore intentional; removing that pin
requires an explicit support-policy review and full integration-matrix validation.
The build uses Node 24, but that does not raise the extension host's runtime.
Dependabot also excludes all `@types/vscode` updates, Node typings 19+, and
Mocha 11+ so routine maintenance cannot silently change these contracts.

## Runtime dependency boundaries

### Physical filesystem

[`src/fs/physical.ts`](../src/fs/physical.ts) loads Electron's built-in
`node:original-fs` at runtime and falls back to `node:fs` in plain Node.
The npm `original-fs` package is deliberately absent. Electron patches ordinary
`node:fs` to treat ASAR archives as directories; working-copy access must see
them as physical files, as SVN does.

Keep this adapter for working-copy filesystem operations. Replacing it with
Electron-patched filesystem calls requires equivalent behavior in
[`asarPhysicalFs.test.ts`](../src/test/asarPhysicalFs.test.ts): a real archive
must be a regular file, directory listing must fail with `ENOTDIR`, and a
subsequent rename must succeed, including on Windows.

### Encoding

Encoding libraries are imported and bundled directly; do not resolve them from
VS Code's private `appRoot/node_modules` layout. `@vscode/iconv-lite-umd`
provides decoding. `jschardet` and `chardet` are not interchangeable cleanup
candidates: [`src/encoding.ts`](../src/encoding.ts) exposes different contracts.

- A UTF-8 or UTF-16 BOM takes precedence over either statistical path.
- The default `jschardet` path samples the first 64 KiB, requires confidence
  of at least 0.8, suppresses ASCII/UTF guesses, and maps IBM866 to `cp866`
  and Big5 to `cp950`.
- With `svn.experimental.detect_encoding`, `chardet` analyzes the buffer.
  `svn.experimental.encoding_priority` acts as an ordered allowlist:
  the first configured name present among candidates wins, after removing
  punctuation and normalizing case. Without a match (including an empty
  priority list), detection returns null unless a BOM was recognized.

[`encoding.test.ts`](../src/test/encoding.test.ts) characterizes these
behaviors, including the existing CP1251 sample classified as
`xmaccyrillic`. Characterization preserves an observed compatibility baseline;
it does not claim that every classification is correct. Consolidating detectors
or changing priority semantics is a behavior change requiring focused tests and
updated setting documentation. Buffered versus streaming decoding is described
in [Architecture](architecture.md); broader settings interactions are tracked
in [#95](https://github.com/AntonM030481/svn-scm/issues/95).
