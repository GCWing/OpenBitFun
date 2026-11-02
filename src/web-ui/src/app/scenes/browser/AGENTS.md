# Browser scene

Native child-view visibility combines the controller window state, active panel,
toolbar transitions, and floating-surface occlusion. Keep native window event
subscriptions in the infrastructure adapter and share them across cached panels.
Do not use window focus alone as visibility: an unfocused window can remain visible.

For preview scheduling and native visibility changes, run:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/browser src/infrastructure/runtime/windowVisibility.test.ts
```

These tests cover event races, scheduling and DOM ownership. They do not establish
native rendering behavior. For minimize/restore changes, also use a real desktop
WebView: verify native minimized state, capture counts, child document visibility
and animation progress while minimized and after restoration. Check that inactive
or occluded panels remain hidden after restoring the window. Report the tested OS
and build profile; local fixtures do not establish remote-scenario behavior.
