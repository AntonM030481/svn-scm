# SVN source control for Visual Studio Code

Modern Subversion integration for everyday development in VS Code, including
large working copies and multi-root workspaces.

![CI](https://github.com/AntonM030481/svn-scm/actions/workflows/main.yml/badge.svg)

## Highlights

- Git-like file and folder staging with **Stage**, **Unstage**, **Commit
  Staged**, and their all-files variants.
- One Source Control provider for opened folders that belong to the same
  physical SVN working copy.
- Three-way text-conflict resolution in VS Code's Merge Editor, with a normal
  editor fallback when the merge editor is unavailable.
- Fast incremental status refresh backed by authoritative SVN reconciliation.
- Repository, file, and branch history, including cancellable text-log search.
- Incoming-change inspection, selective update, changelists, externals, and
  nested working-copy support.
- Quick diffs, gutter decorations, status bar actions, patches, branching,
  switching, cleanup, revert, and commit workflows.

## Requirements

The extension uses your local [SVN command-line client](https://subversion.apache.org)
and supports SVN 1.6 or newer.

On Windows, TortoiseSVN users must install **Command Line Tools** and make
`C:\Program Files\TortoiseSVN\bin` available in `PATH`.

## Installation

Install **SVN** from the VS Code Extensions view. The Marketplace identifier is
`antonm030481.svn-scm-modern`.

For manual or offline installation, see
[Installing from a VSIX](docs/install.md).

Disable another SVN SCM extension if it registers the same working copies, to
avoid duplicate Source Control providers.

## Everyday workflows

### Checkout

Run **SVN: Checkout** from the Command Palette (`Ctrl+Shift+P`), enter the
repository URL, and choose the parent directory for the new working copy.

### Stage and commit

The Source Control view separates **Changes** from **Staged Changes**. Stage
individual files or folders, use **Stage All Changes**, and commit the selected
set with **Commit Staged**. **Commit All Changes** remains available when staging
is not needed.

When multiple opened workspace folders belong to one physical working copy,
their visible changes are combined in one Source Control provider and staged
paths can be committed together.

### Resolve conflicts

Select a text-conflicted file in Source Control to open VS Code's three-way
Merge Editor. The file remains conflicted in SVN until the result is saved
without conflict markers and explicitly or automatically marked resolved.

Tree, property, or incomplete text conflicts open in the normal editor and
retain the explicit SVN resolution commands.

### Inspect history and incoming changes

Repository, file, and branch history are available from the Subversion views
and context menus. Text-log search streams results into a document and can be
cancelled from its progress notification or by closing that document.

Remote status checks may contact the server and run only when requested or when
remote polling is enabled. Incoming changes can be inspected and updated from
the repository tree.

### Work with large working copies

On startup, the extension can restore the previous changes list while SVN
validates the working copy in the background. Small known edits are checked
early, while a full status scan remains the correctness fallback. Normal file
events and local SVN operations use targeted refreshes when safe.

## Settings

Change settings in the VS Code Settings UI or in `settings.json`. See
[settings behavior and application timing](docs/settings.md) for interactions,
validation, and settings that require a refresh or reload.

<!--begin-settings-->
| Config | Description | Default |
| --- | --- | --- |
| `svn.autorefresh` | Whether auto refreshing is enabled | `true` |
| `svn.commit.changes.selectedAll` | Select all files when commit changes | `true` |
| `svn.commit.checkEmptyMessage` | Check empty message before commit | `true` |
| `svn.conflicts.autoResolve` | Automatically mark a conflicted file as resolved after saving it without conflict markers. When disabled, ask for confirmation. | `false` |
| `svn.default.encoding` | Encoding of svn output if the output is not utf-8. When this parameter is null, the encoding is automatically detected. Example: 'windows-1252'. | `null` |
| `svn.defaultCheckoutDirectory` | The default location to checkout a svn repository. | `null` |
| `svn.delete.actionForDeletedFiles` | When a file is deleted, what SVN should do? &#96;none&#96; - Do nothing, &#96;prompt&#96; - Ask the action, &#96;remove&#96; - automatically remove from SVN Allowed values: `"none"`, `"prompt"`, `"remove"`. | `"prompt"` |
| `svn.delete.ignoredRulesForDeletedFiles` | Ignored files/rules for &#96;svn.delete.actionForDeletedFiles&#96;(Ex.: file.txt or \*\*/\*.txt) | `[]` |
| `svn.detectExternals` | Controls whether to automatically detect svn externals. | `true` |
| `svn.detectIgnored` | Controls whether to automatically detect svn on ignored folders. | `true` |
| `svn.diff.withHead` | Show diff changes using latest revision in the repository. Set false to use latest revision in local folder | `true` |
| `svn.enabled` | Whether svn is enabled | `true` |
| `svn.experimental.detect_encoding` | Try the experimental encoding detection | `false` |
| `svn.experimental.encoding_priority` | Priority of encoding | `[]` |
| `svn.gravatar.icon_url` | Url for the gravitar icon using the \<AUTHOR\>, \<AUTHOR_MD5\> and \<SIZE\> placeholders | `"https://www.gravatar.com/avatar/<AUTHOR_MD5>.jpg?s=<SIZE>&d=robohash"` |
| `svn.gravatars.enabled` | Use garavatar icons in log viewers | `true` |
| `svn.ignoreMissingSvnWarning` | Ignores the warning when SVN is missing | `false` |
| `svn.ignoreRepositories` | List of SVN repositories to ignore. | `null` |
| `svn.ignoreWorkingCopyIsTooOld` | Ignores the warning when working copy is too old | `false` |
| `svn.layout.branchesRegex` | Regex to detect path for 'branches' in SVN URL, 'null' to disable. Subpath use 'branches/[^/]+/([^/]+)(/.\*)?' (Ex.: 'branches/...', 'versions/...') | `"branches/([^/]+)(/.*)?"` |
| `svn.layout.branchesRegexName` | Regex group position for name of branch | `1` |
| `svn.layout.showFullName` | Set true to show 'branches/\<name\>' and false to show only '\<name\>' | `true` |
| `svn.layout.tagRegexName` | Regex group position for name of tag | `1` |
| `svn.layout.tagsRegex` | Regex to detect path for 'tags' in SVN URL, 'null' to disable. Subpath use 'tags/[^/]+/([^/]+)(/.\*)?'. (Ex.: 'tags/...', 'stamps/...') | `"tags/([^/]+)(/.*)?"` |
| `svn.layout.trunkRegex` | Regex to detect path for 'trunk' in SVN URL, 'null' to disable. (Ex.: '(trunk)', '(main)') | `"(trunk)(/.*)?"` |
| `svn.layout.trunkRegexName` | Regex group position for name of trunk | `1` |
| `svn.log.length` | Maximum log entries per history page and previous-message list (1-1000; invalid values use 50) | `50` |
| `svn.multipleFolders.depth` | Maximum depth to find subfolders using SVN | `4` |
| `svn.multipleFolders.enabled` | Allow to find subfolders using SVN | `false` |
| `svn.multipleFolders.ignore` | Folders to ignore using SVN | `["**/.git","**/.hg","**/vendor","**/node_modules"]` |
| `svn.path` | Path to the svn executable | `null` |
| `svn.previousCommitsUser` | Exact, case-sensitive author for previous commit messages, searched within the latest 1000 log entries; returns at most svn.log.length messages. Requires svn \>= 1.8 | `null` |
| `svn.refresh.remoteChanges` | Refresh remote changes on refresh command | `false` |
| `svn.remoteChanges.checkFrequency` | Background remote-check interval in seconds. 0 disables polling, not manual remote refresh. Invalid values disable polling | `300` |
| `svn.showOutput` | Show the output window when the extension starts | `false` |
| `svn.showUpdateMessage` | Show the update message when update is run | `true` |
| `svn.sourceControl.changesLeftClick` | Set left click functionality on changes resource state Allowed values: `"open"`, `"open diff"`. | `"open diff"` |
| `svn.sourceControl.combineExternalIfSameServer` | Combine the svn external in the main if is from the same server. | `false` |
| `svn.sourceControl.countUnversioned` | Allow to count unversioned files in status count | `true` |
| `svn.sourceControl.hideUnversioned` | Hide unversioned files in Source Control UI | `false` |
| `svn.sourceControl.ignore` | Minimatch patterns hiding unversioned files in SCM; does not set SVN ignore properties or implement .gitignore files | `[]` |
| `svn.sourceControl.ignoreOnCommit` | Changelists to ignore on commit | `["ignore-on-commit"]` |
| `svn.sourceControl.ignoreOnStatusCount` | Changelists to ignore on status count | `["ignore-on-commit"]` |
| `svn.update.ignoreExternals` | Set to ignore externals definitions on update (add --ignore-externals) | `true` |
<!--end-settings-->

## Limitations

- The extension requires an existing local SVN installation; it does not bundle
  an SVN client.
- Blame annotations are not included. Use a dedicated extension such as
  [blamer-vs](https://marketplace.visualstudio.com/items?itemName=beaugust.blamer-vs).
- GitHub-installed VSIX files do not update automatically through Marketplace.

## Feedback and contributing

- Report bugs, suggestions, and documentation requests in
  [Issues](https://github.com/AntonM030481/svn-scm/issues).
- Contributions are welcome through
  [pull requests](https://github.com/AntonM030481/svn-scm/pulls).
- See the [maintainer documentation](docs/README.md) for architecture,
  development, testing, and release details.

## Project history

This project is a maintained fork of
[JohnstonCode/svn-scm](https://github.com/JohnstonCode/svn-scm). See the
[original contributors](https://github.com/JohnstonCode/svn-scm/graphs/contributors).
Prebuilt VSIX packages remain available from
[GitHub Releases](https://github.com/AntonM030481/svn-scm/releases/latest).
