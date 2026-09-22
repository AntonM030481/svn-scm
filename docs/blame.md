# SVN blame

SVN SCM Modern can annotate a versioned file with the revision that last changed each line.

## Commands

- **SVN: Show Blame** runs blame for the active versioned file.
- **SVN: Hide Blame** removes blame decorations for the active file.
- **SVN: Toggle Blame** switches blame on or off.

When blame is active, the editor gutter groups lines by revision. The active line also shows its revision and author inline. Hovering a decorated line shows revision, author and date. The commit message is loaded lazily for the selected revision instead of fetching log messages for every revision up front.

## Settings

- `svn.blame.auto` automatically enables blame for a versioned file when it becomes active. It is disabled by default because `svn blame` may require repository access and can be expensive on large histories.
- `svn.blame.gutter` controls gutter indicators while blame is active.

## Architecture and performance

Blame uses the existing `SourceControlManager` repository routing and `Repository.exec()` path. It therefore shares the configured SVN executable, repository credentials, encoding, process handling and output logging with the rest of the extension.

Blame is deliberately independent from status refresh. Enabling or using it does not add work to startup status, normal auto-refresh, targeted status refreshes, or remote-status polling.

Decorations are limited to the visible editor ranges plus a buffer. The blame result is cached for the open document. Local edits adjust cached line positions without rerunning `svn blame`; closing the document or hiding blame disposes the cache and all decorations.

The implementation was informed by the MIT-licensed `opista/svn-blamer` extension, but uses this extension's existing SVN and lifecycle infrastructure rather than embedding a second SVN/process/authentication stack.
