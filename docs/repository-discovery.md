# Repository discovery and routing

This document describes how workspace paths become open SVN repositories and
how later commands and virtual documents are routed back to the correct one.

## Responsibilities

`SourceControlManager` is the single owner of discovery and routing. It:

- scans initial and newly added workspace folders;
- detects new SVN metadata created after activation;
- optionally searches below workspace roots;
- opens one `Repository` per workspace projection of a working copy;
- discovers configured externals and ignored nested repositories;
- closes repositories that disappear or leave the workspace;
- resolves paths and VS Code SCM objects to an open repository.

Commands, views, and file-system providers must use this manager instead of
maintaining their own repository registry.

## Initial discovery

After the SVN executable is found, enabling the manager scans every VS Code
workspace folder. `tryOpenRepository()` first checks whether the path is already
owned, then detects `.svn` or `_svn` metadata and asks SVN for the canonical
working-copy root before constructing a `Repository`.

At the top scan level, detection may accept a workspace folder located inside a
working copy and resolve its parent root. Recursive candidates are checked as
their own possible working copies.

The `svn.ignoreRepositories` setting is evaluated in resource scope, so a
workspace can exclude a discovered working copy without disabling SVN globally.

## Recursive discovery

Recursive scanning is controlled by:

- `svn.multipleFolders.enabled`;
- `svn.multipleFolders.depth`;
- `svn.multipleFolders.ignore`.

The scan is depth-bounded and skips matching directories such as dependency or
vendor trees. It is intentionally not an unbounded search of the filesystem.

The three recursive settings are applied together at enable and when they
change. Disabling recursive discovery resets its effective depth and ignore
patterns; unrelated editor settings do not affect discovery. Changes govern
subsequent discovery work without initiating a workspace rescan or closing
already-open repositories. Reload the window to repeat initial discovery with
the new settings.

When an open repository reports ignored items or externals, the manager may
schedule those paths as additional candidates according to `svn.detectIgnored`
and `svn.detectExternals`. Candidate paths are collected and debounced before
opening so one status update cannot start many duplicate scans.

## Discovery after activation

A workspace file-system watcher looks for creation or changes under SVN metadata
directories that are not already owned by an open repository. The metadata path
is converted to its possible working-copy root and queued for a shallow scan.

A directory-level create event is also treated as a bounded candidate. This
covers an existing working-copy tree moved into the workspace when the platform
does not emit descendant `.svn` events. The manager performs one file-type check
and queues only the created directory for the same shallow, debounced validation;
ordinary file events still do not start repository discovery or recursive scans.
Directory-create requests explicitly disable recursion even when configured
workspace discovery has a larger depth. Nested ownership and permission to
recurse are separate discovery options, not inferred from the current depth.
An ancestor repository does not suppress this check: only an already-open exact
working-copy root does, allowing a newly moved nested working copy to become the
more-specific owner.
For SVN clients older than 1.7, known parent ownership is preserved: per-directory
administration metadata and the absence of `wcroot-abspath` do not prove that a
child is an independent working copy.
Automatically discovered legacy candidates are provisional: if a broader parent
is validated later, its provisional child projections are closed before it is
registered. This also covers child-first completion and separate event batches.
Explicit workspace projections and modern nested working copies are not replaced
by this legacy-only policy.
Replacement consults the current workspace folders, so an automatic child that
later becomes an explicit workspace owner is protected without a second cached
copy of workspace membership. Protection uses the manager's actual routed owner,
not containment alone: a folder belonging to a more-specific nested repository
does not promote its provisional ancestor.
Ownership is checked both before asynchronous validation and immediately before
construction, including legacy parent ownership that appeared during the lookup.

Filtering before the debounced queue is important: a general workspace change
must not trigger repository discovery or an `svn info` call.

Workspace-folder changes are handled incrementally. Added folders are scanned.
When a folder is removed, every repository projection below it is considered,
including recursively discovered nested working copies; projections still
covered by another current workspace folder remain open and every uncovered
projection is disposed exactly once.

## Opening and lifecycle

Opening creates a `Repository`, attaches manager-level status and lifecycle
listeners, and publishes `onDidOpenRepository`. Initial status is asynchronous;
the repository can exist while that first snapshot is still pending.

Closing removes all manager listeners, disposes the repository, removes it from
the registry, and publishes `onDidCloseRepository`. Disabling SVN closes every
repository, clears discovery candidates, cancels debounced discovery, and
disposes workspace watchers. Manager disposal also marks discovery inactive
before cleanup. Every asynchronous stage of candidate validation and opening
rechecks the active enable-generation, so neither an in-flight file-type check
nor a queued SVN lookup can enqueue or open another repository after shutdown,
disable, or a disable/re-enable cycle.
The same generation is carried through the entire workspace and recursive scan,
not recaptured for each folder.

Enable transitions acquire listeners and watchers synchronously under the
current generation before awaiting discovery. Disable invalidates that generation
and releases its resources immediately. A failed current enable attempt rolls
back its watchers/repositories; a failed obsolete attempt cannot clean up a newer
session. Configuration-triggered failures are handled and logged, not left as
unhandled rejections. Initial readiness waits for the latest requested transition,
including rapid enable/disable/enable changes. An initially disabled manager is
ready with an empty registry rather than leaving restored documents pending.

Discovery has three separate decisions, all owned by the manager:

| Decision | Rule | Enforcement |
| --- | --- | --- |
| Is the request still valid? | Its enable-generation is active | After asynchronous work and before registration |
| Is the candidate already owned? | Normal scans respect routed ownership; modern nested scans skip exact owners; legacy nested scans respect parent ownership | The same ownership predicate before validation and before construction |
| May this request scan descendants? | Directory-create requests cannot recurse; workspace scans retain configured bounds | An explicit recursion option before directory enumeration |

The final ownership check and construction/registration have no intervening
`await`. A competing lookup may finish, but cannot register between that check
and registration. Cancelling a request invalidates its result; it does not claim
to abort an already running SVN subprocess.

Regression coverage crosses both SVN-await boundaries with disable, disposal,
and disable/re-enable, and checks ownership acquired while a lookup is pending.

## Synchronous routing

`getRepository()` and `getOpenRepository()` resolve already known ownership
without an SVN process. Supported hints include paths, URIs, `Repository`
instances, SCM instances, and resource groups.

The manager delegates this in-memory collection and hint resolution to its
repository registry. The public open-repository view remains available to
existing consumers, while registry mutations invalidate cached routing order.

Path routing sorts open repositories by descending root length. The most
specific matching root therefore wins for nested working copies. Paths below an
external or ignored item reported by the parent are excluded from that parent,
allowing a separately opened child repository to own them.
Once the most-specific containing repository is selected, an excluded subtree
must not fall through to a less-specific ancestor. Synchronous ownership does
not prove that an individual path is versioned; commands such as Add need this
lexical route for unversioned files too.

This in-memory route is the normal and performance-critical path.

## Validated routing

`getRepositoryFromUri()` combines that same ownership decision with path
validation for callers requiring version-control membership, such as changelists:

1. reject paths without an eligible owner, including its excluded subtrees;
2. accept known versioned SCM resources and reject known unversioned/ignored
   resources entirely in memory;
3. while initial status is pending, tentatively route unknown descendants without
   waiting or issuing SVN calls (the existing startup contract);
4. otherwise validate an unknown path with targeted local `svn info`.

A failed validation is final for that path, not an invitation for an ancestor to
claim it. Hidden, excluded, or newly created unversioned files therefore cannot
pass validation merely because they lie below a working-copy root. A clean file
absent from SCM groups is still unknown and requires SVN validation.

Concurrent lookups of the same normalized path in the same repository share one
in-flight validation. Completed results are not cached: changing SVN membership
must be observable on the next request even with automatic refresh disabled.
Membership validation uses `Repository.getInfo()`, which explicitly bypasses
the lower-level two-minute metadata cache; cached `Repository.info()` is not
appropriate for this decision.
Status/repository changes and closure invalidate in-flight results. Before an
asynchronous result is returned, the manager verifies both that it was not
invalidated and that the same repository still owns the path. A newly opened
nested owner cannot receive its parent's stale validation result.

Targeted validation is a fallback for ambiguity, not the default route for every
file access.

## Virtual-document routing

The read-only `svn:` provider is registered before asynchronous discovery so VS
Code can restore diff editors at startup. Reads wait for manager initialization
and then route the underlying filesystem path through the same repository
registry. If SVN initialization fails, the provider returns an unavailable
file-system error instead of leaving the document pending indefinitely.

## Invariants for changes

- There is at most one live `Repository` object for an opened workspace
  projection. Sibling projections may share a canonical working-copy root.
- The most specific valid working-copy root owns a path.
- Parent repositories do not claim separately detected externals or ignored
  nested working copies.
- Routine file events do not start discovery work.
- A created directory may receive one shallow repository check without turning
  ordinary file events into recursive discovery.
- Recursive discovery remains explicitly enabled, bounded, and filtered.
- Normal routing stays in memory; SVN validation is an ambiguity fallback.
- Initial status pending is a real lifecycle phase and must remain routable.
- Opening and closing publish balanced lifecycle events and dispose all owned
  resources.
- Windows and POSIX path normalization preserve their platform semantics.

Tests for this area should cover workspace roots inside working copies, nested
working copies, externals, ignored candidates, multi-root removal, metadata
creation after activation, longest-root routing, initial-status routing, and
manager disable/re-enable.
