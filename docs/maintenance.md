# Maintenance

## Project direction

The project should provide a reliable, native-feeling SVN integration for the
editing workflows supported by VS Code. Changes should preserve predictable SVN
behavior while keeping the extension responsive, diagnosable, and compatible
with supported VS Code versions and operating systems.

The [design principles](design-principles.md) are the primary reference when a
change has several technically valid implementations. User-facing behavior
belongs in the root README and changelog. Implementation decisions and
maintainer workflows belong in `docs/`.

## Project history

This repository originated as a maintained fork of `JohnstonCode/svn-scm`, but
the documentation describes the complete current system rather than only the
fork's differences. Upstream history remains relevant for attribution and for
understanding older design choices.

## Compatibility

- Treat `engines.vscode` as the public minimum-version contract.
- Test both the minimum version and current stable VS Code.
- Preserve Windows, Linux, and macOS path behavior.
- Assume workspaces can be multi-root and can contain nested SVN working copies.
- Avoid using newer VS Code APIs unless the minimum engine is raised.
- The build-time Node version and the extension host's Node version are
  different compatibility targets.

## Lifecycle conventions

Long-lived components must have explicit ownership and cleanup:

- add subscriptions to the owning component's disposable collection;
- clear intervals and delayed callbacks on disable and dispose;
- call `cancelDebounces(this)` in classes with debounced methods;
- make registration explicit and idempotent where tests or reactivation can
  load the same singleton more than once;
- handle partial activation, including SVN discovery failure;
- do not allow pending promises for restored virtual documents to hang forever.

Whenever lifecycle code changes, add a regression test that observes the
resource being released, rather than relying only on coverage of `dispose()`.

## SVN command behavior

- Centralize child-process behavior and error normalization in `Svn`.
- Give commands a meaningful log reason so performance and unexpected refreshes
  can be diagnosed from the output channel.
- Distinguish local, read-only commands from commands that may contact the
  server or mutate the working copy.
- Prefer targeted status refresh after a known operation, retaining a full
  refresh as the correctness fallback.
- Avoid redundant `svn info`, `svn list`, and remote-status calls on hot paths.

## Pull-request checklist

- The change has a focused purpose and an appropriate regression test.
- `yarn check` and `yarn test:unit` pass locally.
- Relevant integration tests pass against the minimum and stable VS Code.
- New listeners, timers, watchers, providers, and callbacks have a clear owner.
- User-visible changes are reflected in `README.md` or `CHANGELOG.md`.
- Maintainer-facing workflow or architecture changes are reflected in `docs/`.
- Changes remain consistent with the invariants in
  [design-principles.md](design-principles.md), or update them explicitly.
- Dependency changes respect the constraints in
  [dependencies.md](dependencies.md).
- Packaging changes have been checked by inspecting the VSIX file list.

## Upstream work

Evaluate upstream commits and open pull requests by behavior, not by applying
them mechanically. The fork has changed its toolchain, activation, tests, and
lifecycle handling, so older patches may need to be reimplemented against the
current architecture. Preserve original attribution when adapting upstream
work.
