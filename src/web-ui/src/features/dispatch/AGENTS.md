# Dispatch observer verification

For observer scheduling, event replay, approval delivery, or persisted job cache
changes, run from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/features/dispatch/DispatchJobObserver.test.ts src/features/dispatch/dispatchJobStore.test.ts src/features/dispatch/dispatchApi.test.ts src/features/dispatch/dispatch.contract.test.ts
```

Keep fast polling for unfinished jobs and terminal jobs whose events are not yet
drained, including hidden windows. Idle discovery must remain bounded and active
so records submitted by another process are found without a renderer event.
Explicit refreshes and local submissions/follow-ups must bypass the idle delay.
Retain single-flight reconciliation, observer teardown, per-observer cursors,
legacy record recovery, and controller polling suppression in Peer Device Mode.

These tests use simulated clocks and host/target APIs. They verify scheduling and
projection contracts, not native CPU usage, OS notification display, or live SSH,
account-device, remote-control, and Detached Dispatch integration.
