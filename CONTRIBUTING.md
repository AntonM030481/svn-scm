# Contributing

Issues and pull requests are welcome. For substantial behavior changes, open an
issue first so the scope and compatibility impact can be discussed.

## Development setup

The project uses Node.js 24 and the Yarn version pinned in `package.json`.
Enable Corepack, install dependencies, and run the standard checks:

```sh
corepack enable
yarn install --immutable
yarn check
yarn test:unit
```

The integration tests also require a Subversion command-line client. See the
[development guide](docs/development.md) for local setup and debugging, and the
[testing guide](docs/testing.md) for the VS Code test matrix.

## Pull requests

- Keep each pull request focused.
- Add regression coverage for behavior changes and bug fixes.
- Update user or maintainer documentation when behavior, architecture, or a
  workflow changes.
- Confirm that CI passes before requesting review.

Read the [design principles](docs/design-principles.md) before changing core
behavior. The [maintenance guide](docs/maintenance.md) contains compatibility,
lifecycle, and review conventions. All maintainer documentation is indexed in
[`docs/`](docs/README.md).
