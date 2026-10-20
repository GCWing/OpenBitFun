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
- Page preparation must retain the scene frame and use `SettingsPage` for its
  fallback. First-load placeholders use `ConfigLoadingState` inside the content
  frame; refreshes retain successful content. Seed editable forms only from a
  complete `ConfigManager` snapshot, never from default values after a failed
  read. Do not hydrate over edits or keep inactive page effects alive for caching.
- Runtime snapshots and scroll positions belong to the current device activation.
  Background responses must not repopulate a previous activation; section links
  take precedence over restored scroll positions.

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

Subscription services group ZCode's regional accounts under one product entry.
Region choice is presentation only: retain each account's provider/credential
identity, show both connected regions, and keep an existing model pinned to its
original region. A new connection can select a region before authorization.
Use the existing host-owned auth APIs and advertised providers, including on peers.

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/settings/pages/ai/subscriptionServices.test.ts src/app/scenes/settings/pages/ai/ZcodeSubscriptionGroup.test.tsx src/infrastructure/config/components/subscriptionLoginCoordinator.test.ts
```

These tests cover product grouping, regional selection and account isolation in
local DOM/fixtures; they do not exercise a real remote host or provider login.

Subscription allowance panels use `useSubscriptionQuota` and the typed host API.
Keep observations scoped to device activation and exact account slot; gate peers
on `subscription_quota_v1`, with an explicit unsupported state and no local
fallback. Refresh visible active panels only, retain failed observations as stale,
and never turn a missing amount into zero. Keep vendor protocol interpretation
in the adapter; UI formats canonical amounts, units, windows and dates.

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/settings/pages/ai/SubscriptionQuotaPanel.test.tsx src/app/scenes/settings/pages/ai/subscriptionQuotaPresentation.test.ts src/infrastructure/config/hooks/useSubscriptionQuota.test.tsx src/infrastructure/api/service-api/AIApi.quota.test.ts src/infrastructure/peer-device/peerCapabilityResolution.test.ts
```

These fixtures verify data presentation and activation/account isolation; they
do not establish rendered visual fidelity or physical remote-host behavior.

Service headings use the provider catalog; account rows use exact host-owned slots
from `list_subscription_account_instances`. Preserve retained signed-out identities,
disabled states, pending new slots and identical labels. Refresh, catalog discovery,
import and sign-out must carry the selected slot; sign-out impact includes only
models/pools which name it. Publish catalog/instance reads together under the device
activation key and hide the previous host's accounts immediately on activation.

OpenCode Go API-key quotas use a saved model ID, gated by
`subscription_model_quota_v1`; no draft credential belongs in that request. Zen and
public free access have explicit informational states plus the console action.

Focused checks:
`pnpm --dir src/web-ui run test:run src/app/scenes/settings/pages/ai/SubscriptionServiceGroup.test.tsx src/app/scenes/settings/pages/ai/subscriptionServices.test.ts src/app/scenes/settings/pages/ai/ZcodeSubscriptionGroup.test.tsx src/app/scenes/settings/pages/ai/OpenCodeModelQuota.test.ts src/infrastructure/api/service-api/AIApi.quota.test.ts`.
These are local DOM/data fixtures, not visual or physical remote-host acceptance.

Grok OAuth period/on-demand allowance requires `grok_quota_v1` on peers in
addition to the existing account-quota capability. Keep API-key model setup in
the ordinary provider/custom model flow; MiniMax, Kimi Code and StepFun have no
separate subscription importer or allowance UI. The existing OpenCode Go path
retains its independently advertised capability.
