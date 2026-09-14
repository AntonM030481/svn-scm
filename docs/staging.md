# Staging model

The extension exposes a Git-like whole-file staging workflow on top of SVN changelists.

## User model

`Staged Changes` appears above `Changes`, matching the built-in VS Code Git provider. `Changes` contains unstaged working-copy changes and `Staged Changes` contains the files selected for the next commit. Stage/Unstage and Stage All/Unstage All mirror the standard VS Code Git interaction model. Files and folders in `Changes` expose Stage (and Revert where applicable); files and folders in `Staged Changes` expose Unstage. The SCM input box is used directly by Commit Staged; Commit All remains available when staging is not desired.

Partial/hunk staging is deliberately separate and tracked by issue #90.

## Persistence

Whole-file staged state is stored in reserved SVN changelist names. This keeps staging with the working copy and survives an extension-host or VS Code restart without a second extension-owned database.

The `__svn_scm_staged__` changelist namespace is reserved for extension-owned staging metadata. The reserved name also encodes whether a file came from a user changelist. Unstage can therefore restore the original changelist even after a reload. Files that were unversioned before staging are marked separately so unstage can return them to an uncommitted state. When staging creates ancestor directories for an unversioned folder, the reserved metadata also records that staging-created directory root relative to the physical working-copy root so the state survives working-copy moves; unstage can then remove only additions introduced by staging and preserve pre-existing user-added directories. After a successful staged commit, reserved membership is removed (or the original user changelist is restored) before refresh so later edits never become staged implicitly.

Reserved staging changelists are implementation details and are presented as one `Staged Changes` SCM group rather than as ordinary user changelists. Each completed SVN status refresh is authoritative: the staging coordinator projects the reserved changelist entries into `Staged Changes` once per refreshed model rather than maintaining an independent second copy of SVN state.

## Shared working copies

The staging scope is the normalized physical SVN working-copy root (`repository.root`), not an individual VS Code workspace folder (`repository.workspaceRoot`).

This matters when one large SVN working copy is opened as several sibling folders in a multi-root VS Code workspace. Each folder may have its own SCM provider for presentation and path routing, but providers with the same physical working-copy root share one logical staging scope:

- Stage All and Unstage All aggregate the opened folders in that working copy.
- Commit Staged gathers staged paths from every opened folder in that working copy and submits one SVN commit.
- Providers backed by different physical working copies remain isolated even when their repository URLs are identical.

Only paths represented by currently opened workspace folders are aggregated; staging does not scan or expose unrelated parts of a large working copy.

## Implementation constraints

SVN changelists apply to files, not directories. Staging an unversioned folder therefore expands its currently known file descendants in the same SCM group; added parent directories are included explicitly in Commit Staged with SVN `--depth empty`, so unstaged siblings are never committed recursively. Unstage restores directory additions created by that staging operation when no staged or unrelated added descendants still require them. Empty directories and directory-only versioned changes (for example, a directory property change) remain in `Changes` and should use Commit All because SVN cannot place them in a changelist.

Stage/unstage operations use the repository operation layer so normal refresh, diagnostics, authentication, and lifecycle rules remain in effect. Single-file and folder Stage/Unstage validate only the selected paths after waiting for active SVN mutations to finish. Stage All and Unstage All operate on the elements already known to the current SCM/staging model and targeted-validate those paths; they do not perform a full working-copy status scan merely to discover more work. Targeted refreshes merge explicit command targets with queued watcher targets so the requested paths cannot be displaced. A full local status remains an exceptional fallback where targeted SVN status is not reliable (currently directory-targeting symlinks), and commit paths may perform broader authoritative validation when the complete commit set is required. None of these validations enables remote status implicitly. SVN status and reserved changelist membership remain authoritative.

## Future partial staging

Issue #90 extends this model with a BASE-relative patch/index for individual hunks. Whole-file staging remains changelist-backed; partial staging requires a separate virtual index because SVN changelists cannot represent line ranges.
