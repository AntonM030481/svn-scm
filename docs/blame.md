# SVN blame

SVN SCM Modern can annotate a saved, versioned file with the revision that last changed each line.

## Commands

- **SVN: Show Blame** runs blame for the active saved versioned file. Save pending editor changes first so filesystem blame data cannot be applied to a different in-memory buffer.
- **SVN: Hide Blame** removes blame decorations for the active file.
- **SVN: Toggle Blame** switches blame on or off.

When blame is active, the editor gutter groups lines by revision. The active line also shows its revision and author inline. Hovering a decorated line shows revision, author and date. The commit message is loaded lazily for the selected revision instead of fetching log messages for every revision up front.

## Settings

- `svn.blame.auto` automatically enables blame for a versioned file when it becomes active. Startup auto-blame waits until repository discovery is complete. It is disabled by default because `svn blame` may require repository access and can be expensive on large histories.
- `svn.blame.gutter` controls gutter indicators while blame is active.

## Architecture and performance

Blame uses the existing `SourceControlManager` repository routing and `Repository.run()` / base repository execution path, so it shares the configured SVN executable, credential retry/prompt flow, encoding, process handling and output logging with the rest of the extension. `BlameController` coordinates editor/repository lifecycle, each loaded document owns a `BlameSession`, and rendering is isolated in `BlameDecorations`.

Blame is deliberately independent from status refresh. Enabling or using it does not add work to startup status, normal auto-refresh, targeted status refreshes, or remote-status polling.

Decorations are limited to the visible editor ranges plus a buffer. The blame result is cached for the open document. Local edits shift attribution for untouched lines and remove attribution from lines changed in memory rather than assigning an old revision to new text. Closing the document, hiding blame, closing its repository, or disposing the extension cancels pending blame/log work and removes the cache and decorations.

The implementation was informed by the MIT-licensed `opista/svn-blamer` extension, but uses this extension's existing SVN and lifecycle infrastructure rather than embedding a second SVN/process/authentication stack.
