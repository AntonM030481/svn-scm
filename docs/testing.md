# Testing

Activation lifecycle regressions are covered by `activationTransaction.test.ts`
(staged registration failures, deferred readiness, missing-SVN recovery and
repeated activation) and `sourceControlManagerLifecycle.test.ts` (overlapping
enable sessions, rollback and close notifications). Pure ownership tests in
`lifecycle.test.ts` bring the unit suite to 25 tests as of issue #64.
The activation fault-injection fixture first finishes real host activation, then
loads an isolated extension module graph while immediately restoring the live
module cache. It verifies distinct singleton owners and checks the live manager,
test command and a real `tempsvnfs:` sentinel after all rollback scenarios.

## Test layers

### Static checks

`yarn check` runs:

1. ESLint over TypeScript sources;
2. Prettier in check mode;
3. strict TypeScript compilation.

This is the common local and CI quality gate.

### Unit tests

`yarn test:unit` runs Mocha directly against `out/test/unit.js`. Run
`yarn test-compile` first after source changes unless another command has
already compiled the tests.

Unit tests should be preferred for parsers, path handling, decorators, error
classification, and other behavior that does not need a live VS Code host.

### Integration tests

`yarn test:integration` uses `@vscode/test-electron` to start a real VS Code
extension host and load `out/test/index.js`. It requires compiled tests and a
working `svn` executable.

Set `CODE_VERSION` to select a VS Code version:

```sh
CODE_VERSION=1.86.0 yarn test:integration
CODE_VERSION=stable yarn test:integration
```

In PowerShell:

```powershell
$env:CODE_VERSION = "stable"
yarn test:integration
```

If `CODE_VERSION` is absent, `@vscode/test-electron` chooses its default.

## CI matrix

CI tests the minimum supported VS Code version, 1.86.0, and the current stable
version on Linux and Windows. macOS runs against stable; VS Code 1.86 is omitted
there because its Electron runtime crashes on current GitHub macOS runners
before extension tests start.

The build job also packages a VSIX, which detects packaging errors and verifies
that only intended runtime files are shipped.

## Regression-test placement

### Coverage baseline and limits

The audit baseline after #63 is 16 host-independent tests: glob matching (2),
SVN error classification (4), commit-message HTML (2), and process execution,
cancellation, and settlement (8). Decoding regressions are in the host-only
`svnStreaming.test.ts` suite. This is a test-count baseline, not
a claim that the extension has adequate percentage coverage. The integration
suite is separate and grows with discovery, lifecycle, routing, and status
regressions; its authoritative counts are the logs of each CI matrix job.

No whole-extension percentage gate is currently claimed. Unit tests load
compiled modules, while a separate VS Code/Electron process loads the compiled
unbundled extension and host tests (`test-compile`, not webpack, runs in the
matrix jobs). The separate packaging job builds the production bundle; the
matrix is not a claim of packaged-bundle execution coverage. Instrumenting only
the unit runner would omit most production behavior. A future coverage gate
must collect both processes and
merge their source-mapped results before choosing a threshold. Until then,
require regression assertions and the full host matrix; prioritize extracting
pure parsing, path classification, and scheduling decisions into the unit
runner without creating a second behavioral implementation.

Packaging guard tests run independently with Node's built-in test runner:
`node --test scripts/check-package-size.test.cjs`. They do not require VS Code
or count toward the extension's unit baseline.

### Placement rules

- Put pure tests under `src/test/` and include them from `src/test/unit.ts`.
- Use the extension-host suite for VS Code registrations, activation, restored
  editors, SCM UI integration, and workspace events.
- Lifecycle regressions should verify both cleanup and safe reuse or
  reactivation when the component supports it.
- Tests that create timers, listeners, temporary repositories, or providers
  must dispose them even when an assertion fails.
