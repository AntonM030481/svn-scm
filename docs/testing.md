# Testing

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

- Put pure tests under `src/test/` and include them from `src/test/unit.ts`.
- Use the extension-host suite for VS Code registrations, activation, restored
  editors, SCM UI integration, and workspace events.
- Lifecycle regressions should verify both cleanup and safe reuse or
  reactivation when the component supports it.
- Tests that create timers, listeners, temporary repositories, or providers
  must dispose them even when an assertion fails.
