export interface DisposableResource {
  dispose(): void;
}

/** One owner, immediate registration, reverse cleanup, including late resources. */
export class DisposableScope implements DisposableResource {
  readonly disposables: DisposableResource[] = [];
  private disposed = false;

  assertActive(): void {
    if (this.disposed) {
      throw new Error("Initialization scope has been disposed");
    }
  }

  add<T extends DisposableResource>(resource: T): T {
    if (this.disposed) {
      resource.dispose();
      this.assertActive();
    }
    this.disposables.push(resource);
    return resource;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    disposeResources(this.disposables);
  }
}

export function disposeResources(resources: DisposableResource[]): void {
  for (const resource of resources.splice(0).reverse()) {
    try {
      resource.dispose();
    } catch (error) {
      // One failing cleanup must not keep later resources alive.
      console.error(error);
    }
  }
}

/** Constructor-safe registration: never evaluate several acquisitions in push(). */
export function registerResources(
  target: DisposableResource[],
  ...factories: Array<() => DisposableResource>
): void {
  try {
    for (const factory of factories) {
      target.push(factory());
    }
  } catch (error) {
    disposeResources(target);
    throw error;
  }
}

/** Readiness is published only after every initialization stage has committed. */
export class InitializationTransaction<T> extends DisposableScope {
  readonly ready: Promise<T>;
  private resolve!: (value: T) => void;
  private reject!: (error: unknown) => void;
  private settled = false;

  constructor() {
    super();
    this.ready = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // A failed bootstrap may not have registered a readiness consumer yet.
    void this.ready.catch(() => undefined);
  }

  commit(value: T): void {
    this.assertActive();
    this.settled = true;
    this.resolve(value);
  }

  fail(error: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.reject(error);
    }
    super.dispose();
  }

  dispose(): void {
    this.fail(new Error("SVN initialization was disposed"));
  }
}
