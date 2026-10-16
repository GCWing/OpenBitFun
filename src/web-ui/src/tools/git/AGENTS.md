# Git state and refresh verification

For changes to Git state subscriptions, polling, refresh scheduling, or workspace
row activation, run the focused contracts from the repository root:

```bash
pnpm --dir src/web-ui run test:run src/tools/git/state/GitStateManager.test.ts src/tools/git/hooks/useGitState.test.tsx src/tools/git/services/GitService.test.ts src/tools/git/services/WorkspaceGitInitializer.test.ts src/app/components/NavPanel/sections/workspaces/workspaceGitRefreshOptions.test.ts
```

Subscriptions observe state; only active consumers register polling demand.
Keep remote polling conservative, serialize background polls per SSH connection,
and preserve manual/operation refreshes during retry backoff. Unchanged refreshes
must not emit state-change events. Retain repository trust error/recovery behavior.

These tests mock host Git calls. Report live SSH and peer-device verification
separately; fake timers and mocked transports are not remote integration evidence.
