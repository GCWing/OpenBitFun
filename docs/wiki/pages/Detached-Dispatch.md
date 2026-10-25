[English] | [简体中文](远程任务派发) · [Home](Home)

# Detached Dispatch

## Submit a target-owned job

Dispatch sends durable work to another OpenBitFun host. After the target durably accepts the job, the controller may disconnect; the target owns the worker, session, worktree, execution log, and permission mailbox.

## Prepare and submit

1. Open a Git repository or managed worktree. Dispatch workspace delivery is Git-only, not arbitrary folder upload.
2. Open the session dispatch picker and select a supported SSH or account-device target.
3. Verify protocol/capabilities, target CLI/runtime readiness, model configuration, and permissions. Review any install/update or model synchronization requested during preparation.
4. Choose the baseline revision and whether to include uncommitted Git-visible changes.
5. Review the objective and submit. Wait for durable target acceptance before disconnecting.
6. Follow job status and recover the execution transcript after reconnecting.

The target receives a managed job worktree, not a caller-selected arbitrary execution folder. When included, uncommitted changes are committed in a controller-managed baseline worktree; the user's checkout is not staged or switched. Git-ignored files such as local .env files and build output are not delivered, so prepare required target dependencies separately.

## Observe, answer, and cancel

Inspect job state, errors, and pending permissions. Answer supported requests remotely, or cancel the target job when intended. The execution host must remain available; a controller disconnect cannot keep a switched-off target running.

If submission outcome is uncertain, inspect the existing job record before making a new job. Reconnectable records are not a reason to erase a failed or offline job.

## Synchronize results deliberately

The controller baseline and target worktree are not a live shared folder. Later changes to your original checkout do not automatically reach the running task. Synchronization imports the target job branch into the managed controller baseline; review those changes before integrating them into your normal branch.

Synchronizing can commit Git-visible changes in the target job worktree. It is an intentional mutation, not a read-only refresh.

[Dispatch ownership and delivery contract](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/architecture/detached-task-dispatch.md)

> Screenshot pending: S32 — target/preflight; S33 — job status, permissions, and sync.
