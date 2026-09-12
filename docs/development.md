# Development

## Requirements

- Git
- Node.js 24
- Corepack
- Subversion command-line client
- a supported VS Code installation for debugging

The package manager is pinned by the `packageManager` field in `package.json`.
Use Corepack instead of installing a separate global Yarn version.

```sh
corepack enable
yarn install --immutable
```

Yarn uses the regular `node_modules` linker, configured in `.yarnrc.yml`.

## Common commands

| Command | Purpose |
| --- | --- |
| `yarn compile` | Run a development webpack build in watch mode |
| `yarn build` | Create the production extension bundle |
| `yarn check` | Run lint, formatting check, and TypeScript compilation |
| `yarn lint:fix` | Apply safe ESLint fixes |
| `yarn style-fix` | Format TypeScript sources with Prettier |
| `yarn test:unit` | Run unit tests against compiled JavaScript |
| `yarn test:integration` | Run tests in a VS Code extension host |
| `yarn test` | Run unit and integration suites |

Run `yarn check` and `yarn test:unit` before pushing. Run the integration suite
when changing activation, VS Code integration, repository discovery, file
systems, commands, or lifecycle behavior.

## Debugging in VS Code

1. Open the repository folder in VS Code.
2. Run `yarn compile` and leave it watching.
3. Select the `Launch Extension` debug configuration.
4. Press F5 to open an Extension Development Host.

The extension uses the machine's `svn` executable. If it is not on `PATH`, set
`svn.path` in the development host.

## Generated and packaged files

- `out/extension.js` is the webpack bundle loaded by VS Code.
- `out/test/` contains JavaScript emitted by `yarn test-compile`.
- `src/tools/generateConfigSectionForReadme.ts` updates the generated settings
  block in the user README.

Do not edit generated output as the source of a change.
