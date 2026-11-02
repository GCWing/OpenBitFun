# MiniApps

Follow `src/web-ui/AGENTS.md` for shared frontend rules. Navigation shortcuts are
controller presentation preferences scoped by the selected device. Catalog
responses must belong to the current surface before updating shortcuts; failed
or empty discovery must not erase preferences. Launch through `useMiniAppLaunch`
so presentation transfer and remote-workspace restrictions remain consistent.

For navigation shortcuts, persistence, catalog ownership and launch behavior:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/miniapps/miniAppNavigationStore.test.ts src/app/scenes/miniapps/hooks/useMiniAppCatalogSync.test.tsx src/app/scenes/miniapps/hooks/miniAppCatalogStartupRefresh.test.ts src/app/scenes/miniapps/hooks/useMiniAppLaunch.test.tsx src/app/scenes/miniapps/components/MiniAppInstalledCard.test.tsx src/app/scenes/miniapps/views/MiniAppLibraryView.navigation.test.tsx src/app/components/NavPanel/components/MiniAppShortcuts.test.tsx src/app/components/NavPanel/MainNav.projectCreation.test.tsx
```

These store and DOM fixtures cover local launches and simulated SSH/Peer surface
restrictions and switches. They do not establish live Remote Workspace, Remote
Control, Peer Device or Detached Dispatch behavior.
