# Build and release

## Build

Webpack bundles `src/extension.ts` and its runtime dependencies into
`out/extension.js`. The `vscode` module remains external because it is supplied
by the extension host. Source maps are generated locally but excluded from the
VSIX.

```sh
yarn check
yarn test:unit
yarn build
```

## Package

Create the same VSIX shape used by CI with:

```sh
yarn vsce package --no-yarn -o svn-scm.vsix
```

`vscode:prepublish` runs the full static check and production build. The
`.vscodeignore` allowlist leaves the webpack bundle, manifest, README,
changelog, license, styles, icons, and images in the package; sources, tests,
tooling, and development configuration are excluded.

Inspect the file list printed by `vsce` whenever packaging rules or build output
change.

## CI artifacts

Every branch push and pull request runs static checks, unit tests, packaging,
and the integration-test matrix. The build job uploads its VSIX as a workflow
artifact for manual validation.

## Release workflow

Releases are driven by tags matching `v*`:

1. update `package.json` to the intended version;
2. add a matching section to `CHANGELOG.md`;
3. merge the release change to `master`;
4. create and push tag `v<package-version>`.

The release workflow verifies that the tag equals the package version, reruns
quality and integration tests, creates `svn-scm-v<version>.vsix`, extracts the
matching changelog section, and publishes a GitHub Release.

Do not move or reuse a published version tag. If a release fails, fix the cause
on a new commit and create the appropriate new version according to the impact
of the change.
