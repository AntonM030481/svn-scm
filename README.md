# Subversion source control for VS Code

> Maintained fork of [JohnstonCode/svn-scm](https://github.com/JohnstonCode/svn-scm).
>
> This fork continues maintenance of the original extension and provides
> downloadable VSIX releases through GitHub.

![CI](https://github.com/AntonM030481/svn-scm/actions/workflows/main.yml/badge.svg)

# Prerequisites

> **Note**: This extension leverages your machine's SVN installation,\
> so you need to [install SVN](https://subversion.apache.org) first.

On reopening a working copy, the extension restores the last changes list while
refreshing in the background. Small known changes are checked first; the full
scan then discovers the remaining changes. Large files are left to the full scan.

## Windows

If you use [TortoiseSVN](https://tortoisesvn.net/), make sure the option
**Command Line Tools** is checked during installation and
`C:\Program Files\TortoiseSVN\bin` is available in PATH.

## Feedback & Contributing

* Please report any bugs, suggestions or documentation requests via the
  [Issues](https://github.com/AntonM030481/svn-scm/issues)
* Feel free to submit
  [pull requests](https://github.com/AntonM030481/svn-scm/pulls)
* See the [maintainer documentation](docs/README.md) for architecture,
  development, testing, and release details

## [Original contributors](https://github.com/JohnstonCode/svn-scm/graphs/contributors)

# Features

### Checkout

You can checkout a SVN repository with the `SVN: Checkout` command in the **Command Palette** (`Ctrl+Shift+P`). You will be asked for the URL of the repository and the parent directory under which to put the local repository.

----

* Source Control View
* Quick Diffs in gutter
* Status Bar
* Create changelists
* Add files
* Revert edits
* Remove files
* Create branches
* Switch branches
* Create patches
* Diff changes
* Commit changes/changelists
* See commit messages

## Log search

Text log search uses the SVN client selected by `svn.path` and the repository's
credentials. Results appear progressively in `tempsvnfs:/svn.log`. Searching
history may contact the SVN server; it only runs when requested.

Cancel the progress notification or close the result document to stop a search.
Starting another search replaces the previous one. Streaming text uses
`svn.default.encoding`, or UTF-8 when unset; set an encoding explicitly for a
client that produces another encoding.

## Blame

Please use a dedicated extension like [blamer-vs](https://marketplace.visualstudio.com/items?itemName=beaugust.blamer-vs)

## Settings
Here are all of the extension settings with their default values. To change any of these, add the relevant Config key and value to your VSCode settings.json file. Alternatively search for the config key in the settings UI to change its value.

See [settings behavior and application timing](docs/settings.md) for interactions,
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

