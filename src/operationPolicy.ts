import { Operation } from "./common/types";

export interface OperationPolicy {
  readonly readOnly: boolean;
  readonly refreshStatus: boolean;
  readonly requiresReadyStatus: boolean;
  readonly locksWorkingCopy: boolean;
  readonly checkRemote: boolean;
  readonly showProgress: boolean;
}

const policy = (overrides: Partial<OperationPolicy> = {}): OperationPolicy =>
  Object.freeze({
    readOnly: false,
    refreshStatus: true,
    requiresReadyStatus: true,
    locksWorkingCopy: true,
    checkRemote: false,
    showProgress: true,
    ...overrides
  });

const readOnly = (showProgress: boolean = true): OperationPolicy =>
  policy({
    readOnly: true,
    refreshStatus: false,
    requiresReadyStatus: false,
    locksWorkingCopy: false,
    showProgress
  });

const status = (checkRemote: boolean = false): OperationPolicy =>
  policy({
    requiresReadyStatus: false,
    locksWorkingCopy: false,
    checkRemote
  });

const READ = readOnly();
const BACKGROUND_READ = readOnly(false);
const MUTATION = policy();

export const operationPolicies = {
  [Operation.Add]: MUTATION,
  [Operation.AddChangelist]: MUTATION,
  [Operation.Changes]: READ,
  [Operation.CleanUp]: MUTATION,
  [Operation.Commit]: MUTATION,
  [Operation.CurrentBranch]: BACKGROUND_READ,
  [Operation.Info]: BACKGROUND_READ,
  [Operation.Ignore]: MUTATION,
  [Operation.List]: READ,
  [Operation.Log]: READ,
  [Operation.Merge]: MUTATION,
  [Operation.NewBranch]: MUTATION,
  [Operation.Patch]: MUTATION,
  [Operation.Remove]: MUTATION,
  [Operation.RemoveChangelist]: MUTATION,
  [Operation.Rename]: MUTATION,
  [Operation.Resolve]: MUTATION,
  [Operation.Resolved]: MUTATION,
  [Operation.Revert]: MUTATION,
  [Operation.Show]: BACKGROUND_READ,
  [Operation.Status]: status(),
  [Operation.StatusRemote]: status(true),
  [Operation.SwitchBranch]: MUTATION,
  [Operation.Update]: MUTATION
} satisfies Record<Operation, OperationPolicy>;

export function getOperationPolicy(operation: Operation): OperationPolicy {
  return operationPolicies[operation];
}

export function isReadOnly(operation: Operation): boolean {
  return getOperationPolicy(operation).readOnly;
}
