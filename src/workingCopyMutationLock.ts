import { AsyncLocalStorage } from "node:async_hooks";
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
