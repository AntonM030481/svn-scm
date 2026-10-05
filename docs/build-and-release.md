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
license, styles, icons, and images in the package; sources, tests, tooling,
development configuration, and the full historical `CHANGELOG.md` are excluded.
Release notes are generated from the repository changelog before packaging, so
the distributable VSIX does not carry obsolete historical Marketplace identities.

Inspect the file list printed by `vsce` whenever packaging rules or build output
change.

## CI artifacts

Pull requests targeting `master` and pushes to `master` run static checks, unit
tests, packaging, and the full integration-test matrix. Feature-branch pushes
do not run a second identical matrix alongside their PR. Open a PR for a feature
branch or use the CI workflow's manual dispatch to validate an arbitrary branch.
The build job uploads its VSIX as a workflow artifact for manual validation.
It also runs the release-tooling regressions with `node --test scripts/*.test.cjs`.

Keep GitHub Actions pinned to immutable commit SHAs and workflow permissions
explicit. Normal validation keeps checkout credentials unpersisted and uses
`contents: read`. Same-repository pull requests have a dedicated formatting job
that temporarily receives `contents: write` and `actions: write`: it runs
`yarn style-fix`, commits formatting-only changes back to the PR branch, and
explicitly dispatches CI for the formatted head. Fork pull requests remain
read-only and are checked without automatic writes. The publishing job receives
`contents: write` only for creating the release. Dependabot checks Actions
weekly. CI and release validation share `.github/workflows/main.yml`.

`package-budgets.json` sets explicit ceilings of 1.5 MiB for the uncompressed
webpack bundle and 768 KiB for the VSIX. Both CI and release packaging reject
missing, empty, non-file, or oversized outputs. Run the guard's boundary tests
with `node --test scripts/check-package-size.test.cjs`. Budget changes require
an explanation of the size increase and inspection of the packaged file list;
do not increase a limit merely to silence a failure.

## Release workflow

Releases are driven by tags matching `v*`:

1. update the release branch from the current `master`;
2. review the complete delta since the previous release tag and make sure the
   release notes describe all meaningful runtime and user-facing changes;
3. update `package.json` to the intended version;
4. add a matching top section to `CHANGELOG.md`;
5. merge the release change to `master` with a commit title beginning
   `Prepare release `.

For version-changing pull requests, CI verifies that the PR head contains the
current base commit and that the top changelog version matches `package.json`.
If `master` moves while a release PR is open, update the release branch, review
the newly included commits, and rerun CI before merging.

The `Tag release` workflow validates that the package version matches the top
changelog release, creates `v<package-version>` on that master commit if it
does not already exist, pushes the tag, and explicitly dispatches the release
workflow for that tag. The explicit dispatch is required because tag pushes made
with GitHub's workflow token do not start another workflow automatically. If a
release attempt fails before a GitHub Release exists, a later validated release
commit may move that unpublished tag for recovery and redispatch the release.
Once a GitHub Release exists, the workflow leaves its tag unchanged and does not
dispatch a duplicate release run. The tagging workflow can also be dispatched
manually from `master` for recovery and has only `contents: write` plus
`actions: write`.

The release workflow accepts either the tag push or that explicit manual
dispatch and verifies that the tag equals the package version, reruns
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

## Marketplace identity

The GitHub repository remains `AntonM030481/svn-scm`, but the distributable
extension uses the distinct product identity **Subversion Workbench** and
Marketplace identifier `antonm030481.subversion-workbench`.

This project is an independent maintained fork of `JohnstonCode/svn-scm`.
Keep that attribution and non-affiliation statement prominent in Marketplace
documentation. Do not reuse the removed `svn-scm-modern` Marketplace identity
or inherited upstream logo assets. The product name and logo must remain
visually distinct from the original extension to avoid Marketplace search
confusion.

The existing `svn.*` commands, configuration keys, URI schemes, and SCM
provider behavior are compatibility surfaces and are not part of the Marketplace
branding. Do not rename them solely for branding; such a migration would be a
separate breaking-change decision.

## Publishing scope

The automated distribution contract is a validated VSIX attached to a tagged
GitHub Release. Microsoft Marketplace publishing is not configured in the
release workflow. Automating it is a separate release decision requiring
explicit credentials, permissions, and dry-run validation; it is not unfinished
work in the current GitHub Release + VSIX pipeline.
