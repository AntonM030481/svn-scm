from pathlib import Path

Path("src/workingCopyMutationLock.ts").write_text(
    '''import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeWorkingCopyRoot } from "./stagingModel";

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const lockTails = new Map<string, Promise<void>>();

async function withLockKey<T>(key: string, run: () => Promise<T>): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(key)) {
    return run();
  }

  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  lockTails.set(key, tail);

  await previous;
  const nextHeld = new Set(held ?? []);
  nextHeld.add(key);

  try {
    return await heldLocks.run(nextHeld, run);
  } finally {
    release();
    if (lockTails.get(key) === tail) {
      lockTails.delete(key);
    }
  }
}

export async function withWorkingCopyMutationLocks<T>(
  roots: string[],
  run: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(roots.map(normalizeWorkingCopyRoot))].sort();

  const acquire = (index: number): Promise<T> => {
    if (index >= keys.length) {
      return run();
    }
    return withLockKey(keys[index], () => acquire(index + 1));
  };

  return acquire(0);
}

export function withWorkingCopyMutationLock<T>(
  root: string,
  run: () => Promise<T>
): Promise<T> {
  return withWorkingCopyMutationLocks([root], run);
}
''',
    encoding="utf-8",
)

repo = Path("src/repository.ts")
text = repo.read_text(encoding="utf-8")
import_marker = 'import { RepositoryFilesWatcher } from "./watchers/repositoryFilesWatcher";\n'
lock_import = 'import { withWorkingCopyMutationLock } from "./workingCopyMutationLock";\n'
if lock_import not in text:
    if import_marker not in text:
        raise SystemExit("repository import marker drifted")
    text = text.replace(import_marker, import_marker + lock_import)

start = text.index("  private async run<T>(\n")
retry = text.index("  private async retryRun<T>(\n", start)
block = text[start:retry]
signature_end = block.index("  ): Promise<T> {\n") + len("  ): Promise<T> {\n")
body = block[signature_end:]
ending = '''    return shouldShowProgress(operation)
      ? window.withProgress({ location: ProgressLocation.SourceControl }, run)
      : run();
  }

'''
if not body.endswith(ending):
    raise SystemExit("repository run ending drifted")
core = body[: -len(ending)]
replacement = (
    block[:signature_end]
    + '''    const execute = async (): Promise<T> => {
'''
    + core
    + '''      return shouldShowProgress(operation)
        ? window.withProgress({ location: ProgressLocation.SourceControl }, run)
        : run();
    };

    const locksWorkingCopy =
      !isReadOnly(operation) &&
      operation !== Operation.Status &&
      operation !== Operation.StatusRemote;

    return locksWorkingCopy
      ? withWorkingCopyMutationLock(this.root, execute)
      : execute();
  }

'''
)
text = text[:start] + replacement + text[retry:]
repo.write_text(text, encoding="utf-8")

stage = Path("src/commands/stage.ts")
text = stage.read_text(encoding="utf-8")
import_marker = 'import { StagingCoordinator } from "../stagingCoordinator";\n'
lock_import = 'import { withWorkingCopyMutationLocks } from "../workingCopyMutationLock";\n'
if lock_import not in text:
    if import_marker not in text:
        raise SystemExit("stage import marker drifted")
    text = text.replace(import_marker, import_marker + lock_import)

old = '''async function waitForSelectedWorkingCopiesIdle(
  staging: StagingCoordinator,
  resources: Resource[]
): Promise<boolean> {
  const sourceControlManager = await getSourceControlManager();
  const repositories = new Set<Repository>();

  for (const resource of resources) {
    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (repository) repositories.add(repository);
  }

  const results = await Promise.all(
    [...repositories].map(repository =>
      waitForWorkingCopyIdle(staging, repository)
    )
  );
  return results.every(Boolean);
}
'''
new = '''async function runWithSelectedWorkingCopiesLocked(
  staging: StagingCoordinator,
  resources: Resource[],
  run: () => Promise<void>
): Promise<void> {
  const sourceControlManager = await getSourceControlManager();
  const repositories = new Set<Repository>();

  for (const resource of resources) {
    const repository = sourceControlManager.getRepository(resource.resourceUri);
    if (repository) repositories.add(repository);
  }

  await withWorkingCopyMutationLocks(
    [...repositories].map(repository => repository.root),
    async () => {
      const results = await Promise.all(
        [...repositories].map(repository =>
          waitForWorkingCopyIdle(staging, repository)
        )
      );
      if (results.every(Boolean)) {
        await run();
      }
    }
  );
}

async function runWithWorkingCopyLocked(
  staging: StagingCoordinator,
  repository: Repository,
  run: () => Promise<void>
): Promise<void> {
  await withWorkingCopyMutationLocks([repository.root], async () => {
    if (await waitForWorkingCopyIdle(staging, repository)) {
      await run();
    }
  });
}
'''
if old not in text:
    raise SystemExit("selected wait helper drifted")
text = text.replace(old, new)

replacements = [
    (
        '''    if (!(await waitForSelectedWorkingCopiesIdle(this.staging, selected))) {
      return;
    }
    const resources = await this.staging.validateStageSelection(selected);
    if (resources.length) {
      await this.staging.stage(resources);
    }
''',
        '''    await runWithSelectedWorkingCopiesLocked(this.staging, selected, async () => {
      const resources = await this.staging.validateStageSelection(selected);
      if (resources.length) {
        await this.staging.stage(resources);
      }
    });
''',
    ),
    (
        '''    if (!(await waitForSelectedWorkingCopiesIdle(this.staging, selected))) {
      return;
    }
    const resources = await this.staging.validateUnstageSelection(selected);
    if (resources.length) {
      await this.staging.unstage(resources);
    }
''',
        '''    await runWithSelectedWorkingCopiesLocked(this.staging, selected, async () => {
      const resources = await this.staging.validateUnstageSelection(selected);
      if (resources.length) {
        await this.staging.unstage(resources);
      }
    });
''',
    ),
    (
        '''    if (!(await waitForWorkingCopyIdle(this.staging, repository))) {
      return;
    }
    const selected = this.staging.unstagedResourcesForWorkingCopy(repository);
    const resources = await this.staging.validateStageSelection(selected);
    if (resources.length) {
      await this.staging.stage(resources);
    }
''',
        '''    await runWithWorkingCopyLocked(this.staging, repository, async () => {
      const selected = this.staging.unstagedResourcesForWorkingCopy(repository);
      const resources = await this.staging.validateStageSelection(selected);
      if (resources.length) {
        await this.staging.stage(resources);
      }
    });
''',
    ),
    (
        '''    if (!(await waitForWorkingCopyIdle(this.staging, repository))) {
      return;
    }
    const selected = this.staging
      .stagedEntriesForWorkingCopy(repository)
      .map(entry => entry.resource);

    await this.staging.validateUnstageSelection(selected);
    await this.staging.unstageAll(repository);
''',
        '''    await runWithWorkingCopyLocked(this.staging, repository, async () => {
      const selected = this.staging
        .stagedEntriesForWorkingCopy(repository)
        .map(entry => entry.resource);

      await this.staging.validateUnstageSelection(selected);
      await this.staging.unstageAll(repository);
    });
''',
    ),
]
for old_text, new_text in replacements:
    if old_text not in text:
        raise SystemExit("stage execute block drifted")
    text = text.replace(old_text, new_text, 1)
stage.write_text(text, encoding="utf-8")

test = Path("src/test/stagingSharedWorkingCopyGuard.test.ts")
text = test.read_text(encoding="utf-8")
if 'import { Operation } from "../common/types";' not in text:
    text = text.replace(
        'import { Repository } from "../repository";\n',
        'import { Operation } from "../common/types";\nimport { Repository } from "../repository";\n',
    )
old = '''      release();
      await stage;
      assert.equal(
        repositoryOne.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === fileOne
        ),
        true
      );
'''
new = '''      let updateStarted = false;
      const updateStartedDisposable = repositoryTwo.onRunOperation(operation => {
        if (operation === Operation.Update) {
          updateStarted = true;
          assert.equal(
            repositoryOne.staged?.resourceStates.some(
              item => item.resourceUri.fsPath === fileOne
            ),
            true
          );
        }
      });
      const update = repositoryTwo.updateRevision();
      assert.equal(updateStarted, false);

      release();
      await stage;
      await update;
      updateStartedDisposable.dispose();
      assert.equal(updateStarted, true);
      assert.equal(
        repositoryOne.staged?.resourceStates.some(
          item => item.resourceUri.fsPath === fileOne
        ),
        true
      );
'''
if old not in text:
    raise SystemExit("guard test drifted")
test.write_text(text.replace(old, new), encoding="utf-8")

Path("src/test/workingCopyMutationLock.test.ts").write_text(
    '''import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import {
  withWorkingCopyMutationLock,
  withWorkingCopyMutationLocks
} from "../workingCopyMutationLock";

suite("Working-copy mutation lock", () => {
  test("serializes one physical working copy and is reentrant", async () => {
    const root = path.join(os.tmpdir(), "svn-scm-lock-a");
    const events: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => (entered = resolve));
    const blocked = new Promise<void>(resolve => (release = resolve));

    const first = withWorkingCopyMutationLock(root, async () => {
      events.push("first");
      await withWorkingCopyMutationLock(root, async () => {
        events.push("nested");
      });
      entered();
      await blocked;
      events.push("first-done");
    });

    await enteredPromise;
    const second = withWorkingCopyMutationLock(root, async () => {
      events.push("second");
    });
    assert.deepStrictEqual(events, ["first", "nested"]);

    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ["first", "nested", "first-done", "second"]);
  });

  test("orders multi-root acquisition without blocking unrelated roots", async () => {
    const rootA = path.join(os.tmpdir(), "svn-scm-lock-a");
    const rootB = path.join(os.tmpdir(), "svn-scm-lock-b");
    const rootC = path.join(os.tmpdir(), "svn-scm-lock-c");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => (entered = resolve));
    const blocked = new Promise<void>(resolve => (release = resolve));

    const both = withWorkingCopyMutationLocks([rootB, rootA], async () => {
      entered();
      await blocked;
    });
    await enteredPromise;

    let unrelatedRan = false;
    await withWorkingCopyMutationLock(rootC, async () => {
      unrelatedRan = true;
    });
    assert.equal(unrelatedRan, true);

    release();
    await both;
  });
});
''',
    encoding="utf-8",
)
