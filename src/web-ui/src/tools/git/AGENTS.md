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

# Branch picker interaction verification

For branch search, tooltip ownership, keyboard navigation, retained exits, and
checkout recovery, run:

```bash
pnpm --dir src/web-ui run test:run src/tools/git/components/BranchQuickSwitch.test.tsx src/tools/git/components/branchSwitchFailure.test.ts src/shared/ui/OverflowText.test.tsx
```

Current checkout selection is separate from virtual keyboard focus. Opening or
filtering the picker keeps focus in search without activating an option's hint;
arrow keys explicitly move virtual focus, which search exposes with
`aria-activedescendant`. The picker declares its trigger owner and logical open
state to the shared overlay coordinator so child hints hide during retained exit.

These DOM fixtures use real design-system overlays with mocked Git calls. They
do not establish native rendering or live remote-scenario behavior.
