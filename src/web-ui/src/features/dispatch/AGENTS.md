# Dispatch observer verification

For observer scheduling, event replay, approval delivery, or persisted job cache
changes, run from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/features/dispatch/DispatchJobObserver.test.ts src/features/dispatch/dispatchJobStore.test.ts src/features/dispatch/dispatchApi.test.ts src/features/dispatch/dispatch.contract.test.ts
```

For permission prompts, stop requests, or the inline transport status, also run
`src/flow_chat/session-drivers/dispatch/DispatchSessionDriver.test.ts` and
`src/features/dispatch/DispatchTransportStatus.test.tsx`.

Keep fast polling for unfinished jobs and terminal jobs whose events are not yet
drained, including hidden windows. Idle discovery must remain bounded and active
so records submitted by another process are found without a renderer event.
Explicit refreshes and local submissions/follow-ups must bypass the idle delay.
Retain single-flight reconciliation of the outbound index, observer teardown,
per-observer cursors, legacy record recovery, and controller polling suppression
in Peer Device Mode. Target status reads run in one serial lane per target, so a
slow or offline target never delays another target or an explicit refresh of a
healthy one; only a failed status read backs a target off. A target answering
that it has no such job is `notFound`, not `unreachable`. Pending permission
prompts are actionable only after a successful status read in this run.

These tests use simulated clocks and host/target APIs. They verify scheduling and
projection contracts, not native CPU usage, OS notification display, or live SSH,
account-device, remote-control, and Detached Dispatch integration.
