# Settings UI

Follow `src/web-ui/AGENTS.md` for shared frontend rules.

## Field sizing

- Settings selection fields (`Select`, `Combobox`, `MultiSelect`) use
  `@openbitfun/ui` with explicit `size="sm"`, including filters and dialogs.
  The application chooses the size; the design system owns its height through
  `control.height.sm` and the active density. Do not assume every form component
  has the same default size.
- Keep height, padding, and open/closed geometry in the public component owner.
  Settings CSS owns layout and width, not private picker variables or pixel
  height overrides. Do not resize Switches, multiline editors, or entire rows
  to compensate for a field mismatch.

## Focused verification

For settings selection sizing, run:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/common/SettingsControlSizing.test.ts src/shared/ui/Select.test.tsx src/shared/ui/Combobox.test.tsx
```

These source and DOM checks do not establish rendered visual fidelity. Follow
the parent guide for `check:web`; do not use browser automation or mock
screenshots as visual proof.

For MCP form editing, JSON compatibility, and import/save behavior, run:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/mcpConfigForm.test.ts src/infrastructure/config/components/McpToolsConfig.test.tsx src/infrastructure/config/components/McpToolsConfig.presentation.test.ts src/infrastructure/api/service-api/MCPAPI.test.ts
```

These checks cover local configuration handling and unavailable-surface gates;
they do not prove an actual remote MCP connection.
