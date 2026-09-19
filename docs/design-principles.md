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

SVN metadata watchers report files such as `wc.db`, not the working path that
caused the write. During a targeted mutation and its short grace period, the
extension therefore suppresses metadata echoes for the whole physical working
copy. A concurrent external SVN process can be hidden during that bounded
window. For each affected opened projection, local status-derived state is
reconciled by its next eligible unsuppressed metadata event when auto-refresh is
enabled, a later operation on that projection that actually takes the
full-status path (including remote-status polling and full-status fallback), or
targeted activity in that projection that covers the externally changed path.
A qualifying scan in one sibling projection does not update the others, and
unrelated targeted activity is not sufficient. A local full status retains
existing `remoteChanges`; only a successful authoritative remote-status scan on
the projection reconciles that group. Cached `svn info` fields, such
as the current branch after an external switch, require repository-info refresh
followed by a model update; either action alone does not guarantee that the
displayed branch changes. Avoid restoring unconditional delayed full status
after every mutation, because that would erase the targeted-refresh benefit for
the normal case.

### Local work should remain local

Typing, saving, opening a diff, and reading local status must not accidentally
introduce network-dependent SVN commands. Commands that may contact the server,
such as remote status and repository history, need an explicit user action or a
documented polling setting.

This distinction keeps the editor responsive on slow or unavailable networks.

### One provider per physical working copy

Each opened workspace projection retains a `Repository` for status, operations,
watchers, snapshots, and path routing. Sibling projections sharing a canonical
working-copy root are presented through one VS Code SCM provider whose groups
contain the deduplicated union of those opened scopes. Workspace folders are a
visibility boundary: unopened parts of a larger working copy are not projected
or implicitly included in provider-level commands.
`SourceControlManager` owns discovery and routing across repositories; commands
and views should ask it for the repository rather than reimplementing path
discovery.

Nested working copies, ignored roots, externals, and multi-root workspaces make
simple “first path prefix wins” routing incorrect. The most specific valid
working-copy owner must win.

### Local filesystem path identity is normalized

Local filesystem paths are compared by filesystem identity, not by their raw
URI/string spelling. Code that compares, deduplicates, or uses local paths as
`Map`/`Set` keys must use `normalizePath(fsPath)` (or `pathEquals()` for
pairwise equality). On Windows this makes drive-letter and UNC comparisons
case-insensitive and normalizes separator variants.

Keep the original path when passing a target to SVN/the filesystem or displaying
it to the user; normalization is for identity keys and comparisons. Physical
working-copy roots use the stricter `normalizeWorkingCopyRoot()` helper.

This rule does **not** apply mechanically to repository URLs or virtual
`svn:`/`tempsvnfs:` URIs. Those are URI identities and may legitimately use
their serialized URI form as cache keys.

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
| One SCM provider per physical working copy | Matches SVN ownership while allowing workspace folders to limit visible paths | Keep status/routing scopes independent and aggregate only currently opened scopes |
| Register virtual file systems before SVN discovery completes | VS Code may restore diff editors immediately during startup | Initialization failure must resolve restored reads with a useful error, never a permanently pending promise |
| Use `svn:` for repository-backed read-only content | Integrates BASE, HEAD, and revision content with native editors and diffs | Keep the provider read-only and avoid remote or expensive metadata calls from `stat()` |
| Use `tempsvnfs:` for ephemeral history files | Some comparisons need materialized content with a stable document URI | Delete content when documents close and clear buffered events on disposal |
| Debounce watcher-driven refreshes | File operations generate bursts of duplicate events | Cancel pending callbacks on disable/dispose and never use debounce to hide correctness races |
| Suppress mutation metadata echoes per physical working copy | `.svn` events do not identify the working path and otherwise duplicate post-operation status | Keep the window bounded, keep unrelated working-file events eligible, and document that concurrent external SVN metadata writes may need a later refresh |
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
