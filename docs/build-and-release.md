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
node scripts/check-package-size.cjs svn-scm.vsix
```

`vscode:prepublish` runs the full static check and production build. The
`.vscodeignore` exclusions leave the webpack bundle, manifest, README,
changelog, license, styles, icons, and images in the package; sources, tests,
tooling, and development configuration are excluded.

Inspect the file list printed by `vsce` whenever packaging rules or build output
change.

## CI artifacts

Pull requests targeting `master` and pushes to `master` run static checks, unit
tests, packaging, and the full integration-test matrix. Feature-branch pushes
do not run a second identical matrix alongside their PR. Open a PR for a feature
branch or use the CI workflow's manual dispatch to validate an arbitrary branch.
The build job uploads its VSIX as a workflow artifact for manual validation.

`package-budgets.json` sets explicit ceilings of 1.5 MiB for the uncompressed
webpack bundle and 768 KiB for the VSIX. Both CI and release packaging reject
missing, empty, non-file, or oversized outputs. Run the guard's boundary tests
with `node --test scripts/check-package-size.test.cjs`. Budget changes require
an explanation of the size increase and inspection of the packaged file list;
do not increase a limit merely to silence a failure.

## Release workflow

Releases are driven by tags matching `v*`:

1. update `package.json` to the intended version;
2. add a matching section to `CHANGELOG.md`;
3. merge the release change to `master`;
4. create and push tag `v<package-version>`.

The release workflow verifies that the tag equals the package version, reruns
the same reusable CI workflow (including the full OS/minimum/stable matrix),
creates `svn-scm-v<version>.vsix`, checks its budgets, extracts the
matching changelog section, and publishes a GitHub Release.

Release notes are selected by literal version with `scripts/release-notes.cjs`.
The parser stops at the next release heading, including prereleases, and fails
if the requested section is missing or empty. Preview without publishing using
`node scripts/release-notes.cjs 2.19.0`. Run all release-tooling regressions with
`node --test scripts/*.test.cjs`.

Do not move or reuse a published version tag. If a release fails, fix the cause
on a new commit and create the appropriate new version according to the impact
of the change.
