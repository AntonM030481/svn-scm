# Design principles

This document defines the direction of the project. It is intended to prevent
locally reasonable changes from gradually making the extension slower, less
predictable, or harder to maintain.

## Product boundary

The extension integrates an existing local Subversion installation with VS
Code. It should make normal working-copy operations feel native to VS Code,
while preserving SVN terminology and behavior.

The extension is not an SVN implementation, a repository server, or a general
replacement for every feature of a desktop SVN client. New functionality
should primarily improve source-control workflows performed while editing code.

## Principles

### Correctness before refresh optimization

The UI must eventually reflect the actual working-copy state. Targeted and
incremental refreshes are optimizations over a known-correct full `svn status`
refresh, not independent state models.

When adding an optimization:

- retain a full-refresh fallback for ambiguous results;
- update all affected resource groups atomically from one logical snapshot;
- add tests for moves, deletes, changelists, conflicts, externals, and nested
  targets when relevant;
- do not infer SVN state solely from file-system events.

### Local work should remain local

Typing, saving, opening a diff, and reading local status must not accidentally
introduce network-dependent SVN commands. Commands that may contact the server,
such as remote status and repository history, need an explicit user action or a
documented polling setting.

This distinction keeps the editor responsive on slow or unavailable networks.

### One model per working copy

Each detected working copy is represented by one `Repository`, which owns its
VS Code SCM instance and derived UI state. `SourceControlManager` owns discovery
and routing across repositories; commands and views should ask it for the
repository rather than reimplementing path discovery.

Nested working copies, ignored roots, externals, and multi-root workspaces make
simple “first path prefix wins” routing incorrect. The most specific valid
working-copy owner must win.

### The SVN CLI is the behavioral authority

All SVN operations go through the local command-line client. This provides
compatibility with the user's SVN configuration, credentials, working-copy
format, and server. XML output should be preferred where SVN provides it;
parsing human-readable localized output should be avoided.

Child-process execution, encoding, logging, and error normalization belong in
the `Svn` layer. Higher layers decide *which* operation to run, not how to spawn
the process.

### VS Code owns presentation

Use native Source Control groups, commands, status bars, tree views, quick diff,
and file-system providers where possible. Keep business and SVN state outside
view providers so multiple UI surfaces observe the same repository model.

Virtual documents are read-only projections of repository content. They should
not become a second persistent cache or source of truth.

### Explicit lifecycle ownership

An extension host is long-lived and can reopen workspaces, disable configuration,
restore editors, and partially fail during activation. Every listener, watcher,
timer, provider, deferred callback, and cache therefore needs a clear owner and
bounded lifetime.

Disposal is part of behavior, not housekeeping. A component must not publish
events or mutate state after it is disabled or disposed.

### Minimum-version compatibility is intentional

The declared VS Code engine is a tested contract. Production code is written
against that API surface even when development uses a newer VS Code and Node.js.
Raising the minimum version must be an explicit product decision justified by a
needed API or removal of a significant maintenance burden.

### Diagnostics should explain expensive work

SVN calls can be slow and environment-dependent. Command output must include
enough repository and reason context to distinguish discovery, local refresh,
targeted refresh, remote status, quick diff, and user operations. Prefer
observable behavior over silent heuristics that are difficult to debug.

## Current architecture decisions

| Decision | Why | Guardrail |
| --- | --- | --- |
| Use the local `svn` CLI | Respects the user's SVN ecosystem and avoids maintaining a protocol client | Do not add a bundled SVN binary or a second SVN implementation without an explicit architecture review |
| One `Repository` per working copy | Gives SCM state and lifecycle a single owner | Views and commands must not maintain competing repository state |
| Register virtual file systems before SVN discovery completes | VS Code may restore diff editors immediately during startup | Initialization failure must resolve restored reads with a useful error, never a permanently pending promise |
| Use `svn:` for repository-backed read-only content | Integrates BASE, HEAD, and revision content with native editors and diffs | Keep the provider read-only and avoid remote or expensive metadata calls from `stat()` |
| Use `tempsvnfs:` for ephemeral history files | Some comparisons need materialized content with a stable document URI | Delete content when documents close and clear buffered events on disposal |
| Debounce watcher-driven refreshes | File operations generate bursts of duplicate events | Cancel pending callbacks on disable/dispose and never use debounce to hide correctness races |
| Combine initial local and remote status when polling is enabled | Avoids two back-to-back scans because remote status already includes local state | Do not add a second unconditional initial status call |
| Bundle runtime code with webpack | Produces a small, predictable VSIX without runtime package installation | Keep `vscode` external and inspect VSIX contents after build changes |
| Test minimum and stable VS Code | Protects the compatibility floor while detecting platform drift | Do not treat “works on current VS Code” as sufficient evidence |
| Use Yarn with the `node_modules` linker | Gives reproducible installs while remaining compatible with VS Code tooling | Change the linker only after build, test-host, debugger, and packaging validation |

## How to change a decision

These rules are defaults, not permanent prohibitions. A change is appropriate
when its benefit and compatibility impact are explicit.

For a decision-level change:

1. describe the problem and the alternatives considered in the pull request;
2. update this document and the architecture document in the same change;
3. add tests that protect the new invariant;
4. validate the full OS and VS Code matrix;
5. record any migration or rollback implications.

A separate ADR system can be introduced later if decision history becomes hard
to follow. Until then, this document records the current decision and Git
history records how it evolved.
