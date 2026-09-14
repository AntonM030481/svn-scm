# Repository instructions for coding agents

## Read before changing code

For every code change, read:

- `docs/design-principles.md`
- `docs/architecture.md`
- the relevant specialized document:
  - `docs/status-and-refresh.md` for status, watchers, operations, or refreshes;
  - `docs/repository-discovery.md` for discovery, routing, externals, or
    multi-root behavior;
  - `docs/dependencies.md` for dependency or compatibility changes;
  - `docs/testing.md` and `docs/build-and-release.md` for CI, tests, packaging,
    or releases.

Treat `package.json`, `.yarnrc.yml`, and `.github/workflows/` as the source of
truth when a command or version in prose disagrees with configuration.

## Architectural invariants

- The local SVN CLI is the authority for working-copy state.
- VS Code SCM groups are projections of SVN status, not a second state model.
- `SourceControlManager` owns repository discovery and routing.
- One `Repository` owns one opened workspace projection and its VS Code SCM
  instance. Sibling workspace folders may project the same physical working
  copy separately; physical-root features must coordinate those projections.
- File-system events schedule validation; they do not prove an SVN transition.
- Targeted and incremental status are optimizations with a full-status fallback.
- Local editor workflows must not accidentally introduce network SVN calls.
- Listeners, timers, watchers, providers, caches, and deferred callbacks require
  explicit lifecycle ownership and disposal.
- Preserve minimum VS Code 1.86, multi-root, nested-working-copy, and
  cross-platform path compatibility unless a change explicitly revises them.

Do not cross these boundaries as part of an unrelated refactor. If a change
intentionally changes an invariant, update the relevant documentation and
explain the decision in the pull request.

## Development workflow

- Use Node.js 24 and the Yarn version pinned in `package.json` through Corepack.
- Install with `yarn install --immutable`.
- Do not edit generated `out/` files or the generated settings block in
  `README.md` by hand.
- Keep changes focused and preserve unrelated user work in the tree.
- Add regression coverage for behavior changes and bug fixes.
- Update user documentation for behavior changes and maintainer documentation
  for architecture or workflow changes.
- Do not leave temporary diagnostics, patch scripts, or validation workflows in
  the final pull request.

## Validation

At minimum, run:

```sh
yarn check
yarn test:unit
```

Run `yarn test:integration` for activation, commands, repository discovery,
status/refresh, watchers, virtual file systems, VS Code API, or lifecycle work.
Build and inspect a VSIX for dependency, webpack, manifest, packaging, or
release changes.

Do not merge with failing required CI or unresolved review comments.
