# Staging model

The extension exposes a Git-like whole-file staging workflow on top of SVN changelists.

## User model

`Changes` contains unstaged working-copy changes and `Staged Changes` contains the files selected for the next commit. Stage/Unstage and Stage All/Unstage All mirror the standard VS Code Git interaction model. The SCM input box is used directly by Commit Staged; Commit All remains available when staging is not desired.

Partial/hunk staging is deliberately separate and tracked by issue #90.

## Persistence

Whole-file staged state is stored in reserved SVN changelist names. This keeps staging with the working copy and survives an extension-host or VS Code restart without a second extension-owned database.

The `__svn_scm_staged__` changelist namespace is reserved for extension-owned staging metadata. The reserved name also encodes whether a file came from a user changelist. Unstage can therefore restore the original changelist even after a reload. Files that were unversioned before staging are marked separately so unstage can return them to an uncommitted state.

Reserved staging changelists are implementation details and are presented as one `Staged Changes` SCM group rather than as ordinary user changelists.

## Shared working copies

The staging scope is the normalized physical SVN working-copy root (`repository.root`), not an individual VS Code workspace folder (`repository.workspaceRoot`).

This matters when one large SVN working copy is opened as several sibling folders in a multi-root VS Code workspace. Each folder may have its own SCM provider for presentation and path routing, but providers with the same physical working-copy root share one logical staging scope:

- Stage All and Unstage All aggregate the opened folders in that working copy.
- Commit Staged gathers staged paths from every opened folder in that working copy and submits one SVN commit.
- Providers backed by different physical working copies remain isolated even when their repository URLs are identical.

Only paths represented by currently opened workspace folders are aggregated; staging does not scan or expose unrelated parts of a large working copy.

## Implementation constraints

SVN changelists apply to files, not directories. Folder staging therefore expands the relevant changed files. Newly staged unversioned files are first scheduled with `svn add` and then placed in the reserved staging changelist.

Stage/unstage operations use the repository operation layer so normal refresh, diagnostics, authentication, and lifecycle rules remain in effect. The UI can reconcile optimistically where safe, but SVN status remains authoritative.

## Future partial staging

Issue #90 extends this model with a BASE-relative patch/index for individual hunks. Whole-file staging remains changelist-backed; partial staging requires a separate virtual index because SVN changelists cannot represent line ranges.
