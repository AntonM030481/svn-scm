import * as assert from "assert";
import { Operation } from "../common/types";
import {
  getOperationPolicy,
  isReadOnly,
  operationPolicies
} from "../operationPolicy";

suite("Operation policy", () => {
  test("defines behavior for every operation", () => {
    assert.deepStrictEqual(
      Object.keys(operationPolicies).sort(),
      Object.values(Operation).sort()
    );
  });

  test("keeps reads, status and mutations distinct", () => {
    assert.strictEqual(isReadOnly(Operation.Log), true);
    assert.strictEqual(getOperationPolicy(Operation.Log).refreshStatus, false);

    const status = getOperationPolicy(Operation.StatusRemote);
    assert.strictEqual(status.readOnly, false);
    assert.strictEqual(status.requiresReadyStatus, false);
    assert.strictEqual(status.locksWorkingCopy, false);
    assert.strictEqual(status.checkRemote, true);

    const mutation = getOperationPolicy(Operation.Commit);
    assert.strictEqual(mutation.requiresReadyStatus, true);
    assert.strictEqual(mutation.locksWorkingCopy, true);
    assert.strictEqual(mutation.refreshStatus, true);

    const patch = getOperationPolicy(Operation.Patch);
    assert.strictEqual(patch.readOnly, false);
    assert.strictEqual(patch.locksWorkingCopy, true);
  });

  test("keeps background reads out of the SCM progress UI", () => {
    for (const operation of [
      Operation.CurrentBranch,
      Operation.Info,
      Operation.Show
    ]) {
      assert.strictEqual(getOperationPolicy(operation).showProgress, false);
    }
    assert.strictEqual(getOperationPolicy(Operation.Log).showProgress, true);
  });
});
