# Settings behavior and application timing

The generated [settings reference](../README.md#settings) lists all 44
supported keys and defaults. All settings have window scope unless specified:
`svn.path` has machine scope and `svn.ignoreRepositories` has resource scope.
Folder-specific values therefore apply only to the latter. Legacy
`svn.layout.trunk`, `.branches`, and `.tags` are not supported settings; the
unused `getBranches` helpers that read them have been removed. Branch browsing
uses the regex settings and SVN directory listing.

## Applying changes

| Settings | When the new value takes effect |
| --- | --- |
| `path`, `showOutput` | Next extension activation; reload the window. |
| `enabled` | Immediately starts or disposes the manager and its repositories. |
| `multipleFolders.enabled/depth/ignore` | Together, on subsequent discovery requests. No automatic recursive rescan or closure of existing repositories; reload to repeat startup discovery. Disabled recursion always means depth zero. |
| `ignoreRepositories` | When a candidate repository is opened, evaluated for that resource. Does not evict already open repositories. Reload to apply it to the initial set. |
| `detectExternals`, `detectIgnored` | On the next accepted status/discovery pass. Previously scheduled candidates and already open repositories are not withdrawn. Refresh to discover newly enabled candidates; reload to rebuild the set. |
| `remoteChanges.checkFrequency` | Replaces the background timer immediately. Disabling it invalidates waiting polls, but does not erase the last known remote list or cancel a remote command already running. |
| `sourceControl.hideUnversioned/countUnversioned/ignore/ignoreOnStatusCount`, `diff.withHead`, `sourceControl.changesLeftClick` | Immediately rebuild SCM rows/counts from the last accepted status, with no SVN call. Existing diff editors are unchanged; reopen the diff to apply its new mode. |
| `sourceControl.combineExternalIfSameServer` | Runs a full status to collect the newly required external metadata. “Same server” means equal repository UUID, not hostname. |
| `gravatar.icon_url`, `gravatars.enabled` | Next tree-item render uses current settings. History is not reloaded automatically; use its refresh action to redraw visible items (which can fetch history). |
| `layout.*` | Next branch-name calculation or branch selection; Refresh updates the status bar. Invalid expressions disable the affected matching rule. |
| `log.length`, `previousCommitsUser` | Next history page or previous-message request; cached history is not automatically refetched. |
| Other command and decoding settings | Next corresponding command/output decode. |

## Refresh, filters, and commands

`autorefresh` controls local filesystem-driven refresh. It does not disable
remote polling, explicit Refresh, or status validation after SVN operations.
`refresh.remoteChanges=true` makes Refresh await one combined local/remote
status even when `remoteChanges.checkFrequency=0`. The default Refresh is local.
Background polls wait for an idle, focused window and coalesce while waiting;
manual refresh waits for operations but does not require window focus. Disposal
prevents queued work and late status publication.

`sourceControl.ignore` uses minimatch patterns for unversioned SCM rows, with
basename matching and dotfiles enabled. It is not a `.gitignore` parser and does
not write `svn:ignore`. `files.exclude` also filters the SCM projection. Hidden
unversioned rows are excluded from the displayed count even when
`countUnversioned=true`. `ignoreOnStatusCount` excludes named changelists from
that count, not from SCM. `ignoreOnCommit` excludes named changelists from the
implicit commit-all selection; an explicitly selected resource can still be
committed. The delete ignored-rules setting matches relative and absolute paths.

`update.ignoreExternals` adds `--ignore-externals` to normal Update. Selective
incoming update always excludes externals as required by that command's
explicit-target contract. Conflict, delete, add, diff, and update prompt options
are evaluated when their command runs.

`previousCommitsUser` is a case-sensitive, literal author name, including any
wildcard characters. The extension checks the latest 1000 log entries affecting
the working copy and returns at most `log.length` matching messages. Older
authors may therefore return fewer or no entries. This intentionally avoids
SVN [`--search`](https://svnbook.red-bean.com/en/1.8/svn.ref.svn.c.log.html), which
also searches messages, dates and paths using glob patterns.

## Numeric and regex validation

The schema requires integers. Runtime guards also cover values entered outside
the settings UI:

| Setting | Range | Invalid persisted value |
| --- | --- | --- |
| `remoteChanges.checkFrequency` | 0–2147483 seconds | Polling disabled; manual refresh still works. |
| `multipleFolders.depth` | 0–100 | Default 4, or effective 0 when recursion is disabled. |
| `log.length` | 1–1000 | Default 50. |
| `layout.*RegexName` | 1–100 | Disable the affected layout rule. |

Capture indexes refer to groups inside the user's regex. A missing group,
malformed regex, empty regex or `null` regex produces no match rather than
interrupting status or branch workflows. Missing settings retain schema defaults.

## Output encoding compatibility

XML output is always decoded as UTF-8. Buffered non-XML output first tries BOM
and statistical detection; `default.encoding` is the fallback, not a forced
override. Invalid/unsupported encoding names fall back to UTF-8. Streaming
non-XML output cannot inspect the complete buffer and uses `default.encoding`
from the start, falling back to UTF-8.

With `experimental.detect_encoding=true`, `experimental.encoding_priority` is
an ordered allowlist of detector candidates. An empty list produces no detected
encoding unless a BOM is present, so decoding falls back to `default.encoding`.
Invalid lists are treated as empty; non-string elements are ignored. This
preserves the existing detector selection and its characterized Cyrillic
classification. Changing an encoding does not redecode an already open editor.
