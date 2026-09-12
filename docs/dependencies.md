# Dependencies

## Policy

The lockfile is authoritative and installs must use `yarn install --immutable`.
Dependabot proposes weekly patch and minor updates as a group. Major updates are
reviewed separately because this extension runs inside VS Code's Electron and
Node environment rather than an arbitrary system Node.js process.

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

## Updating dependencies

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
