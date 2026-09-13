import * as assert from "assert";
import {
  DisposableScope,
  InitializationTransaction,
  registerResources
} from "../lifecycle";

suite("Initialization ownership", () => {
  test("disposes in reverse order exactly once", () => {
    const scope = new DisposableScope();
    const order: number[] = [];
    scope.add({
      dispose: () => {
        order.push(1);
      }
    });
    scope.add({
      dispose: () => {
        order.push(2);
      }
    });
    scope.dispose();
    scope.dispose();
    assert.deepStrictEqual(order, [2, 1]);
  });

  test("rejects and releases resources arriving after disposal", () => {
    const scope = new DisposableScope();
    scope.dispose();
    let disposed = 0;
    assert.throws(
      () =>
        scope.add({
          dispose: () => {
            disposed++;
          }
        }),
      /disposed/
    );
    assert.equal(disposed, 1);
  });

  for (let failing = 0; failing < 4; failing++) {
    test(`rolls back constructor acquisition failure at stage ${failing}`, () => {
      const resources: Array<{ dispose(): void }> = [];
      const disposed: number[] = [];
      assert.throws(
        () =>
          registerResources(
            resources,
            ...[0, 1, 2, 3].map(stage => () => {
              if (stage === failing) {
                throw new Error("acquisition");
              }
              return {
                dispose: () => {
                  disposed.push(stage);
                }
              };
            })
          ),
        /acquisition/
      );
      assert.deepStrictEqual(
        disposed,
        Array.from({ length: failing }, (_, i) => i).reverse()
      );
      assert.equal(resources.length, 0);
    });
  }

  test("readiness only exposes a committed result", async () => {
    const transaction = new InitializationTransaction<object>();
    let published = false;
    const value = {};
    const ready = transaction.ready.then(result => {
      published = true;
      return result;
    });
    transaction.add({ dispose: () => {} });
    await Promise.resolve();
    assert.equal(published, false);
    transaction.commit(value);
    assert.equal(await ready, value);
    transaction.dispose();
  });

  test("failure rejects readiness and rolls back all acquired resources", async () => {
    const transaction = new InitializationTransaction<object>();
    let disposed = 0;
    transaction.add({
      dispose: () => {
        disposed++;
      }
    });
    transaction.fail(new Error("later stage"));
    await assert.rejects(transaction.ready, /later stage/);
    assert.equal(disposed, 1);
    assert.throws(() => transaction.commit({}), /disposed/);
  });

  test("disposal settles readiness even before consumers attach", async () => {
    const transaction = new InitializationTransaction<object>();
    transaction.dispose();
    await assert.rejects(transaction.ready, /disposed/);
  });
});
