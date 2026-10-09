# Settings scene

Follow `src/web-ui/AGENTS.md` and the settings control sizing rules in
`src/web-ui/src/infrastructure/config/AGENTS.md`.

## Ownership

- `settingsRegistry.ts` owns category order, page destinations, lazy loading,
  namespace preloading, and searchable inline sections.
- `pages/{application,ai,development,tools,data}` owns settings presentation.
  Configuration services, persisted shapes, host adapters, and reusable
  configuration editors remain in infrastructure or their feature owners.
- Name destination components `*SettingsPage` and inline content `*Section`.
  Composed pages use `pages/shared/SettingsPage.tsx` for one title and one scroll
  owner. Sections must not add page shells or secondary navigation. Existing
  ACP connection modes are owned by the external-agent editor.
- Keep Pet & assistant as a separate page containing pet preferences and real-time
  voice calls. Voice dictation stays in Input & interaction. Keyboard shortcuts use one searchable list;
  shortcut scopes still determine runtime dispatch and conflict semantics.
- Navigation aliases belong in `settingsDestinationMigrations.json`, shared by
  `settingsDestination.ts` and the capability catalog validator. Preserve old page and
  view payloads; new callers use canonical destinations. `sectionId` scrolls
  inside the current page and must not discard drafts or trigger a leave prompt.
- Stable product-control capability IDs are host contracts. Project their UI
  destinations in `app/global-search/settingsCapabilityDestination.ts`; do not
  rename generated protocol IDs to match sidebar labels.
- Moving a setting must preserve its execution host, remote capability gates,
  unsupported states, persistence keys, and draft registration.

## Focused verification

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/settings src/app/global-search/interactiveCapabilityActivator.test.ts src/infrastructure/config/settingsDraftRegistry.test.ts src/flow_chat/components/btw/DeepReviewActionBar.test.tsx src/infrastructure/config/components/AcpAgentsConfig.test.tsx src/infrastructure/config/components/AppearancePackageConfigSection.test.tsx
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/common/SettingsControlSizing.test.ts
```

Follow the parent guide for `check:web`, i18n, and Appearance registration checks.
When changing destination migrations or catalog source evidence, also run
`pnpm run capabilities:generate`, `pnpm run capabilities:check`, and
`pnpm run capabilities:test`; retain historical wire destinations for older clients.
These source and DOM tests do not establish visual or remote runtime behavior.
