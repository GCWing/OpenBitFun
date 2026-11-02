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

For logging preference changes and sensitive-data redaction before startup reads finish:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/services/FrontendLogLevelSync.test.ts src/infrastructure/config/services/FrontendLogLevelSync.privacy.test.ts src/shared/utils/logger.test.ts src/flow_chat/services/EventBatcher.test.ts
```

These fixtures exercise the real frontend logger and event batcher with delayed
configuration reads; they do not establish live remote transport behavior.

For loading states, warm snapshots, asynchronous reads, and device isolation:

```bash
pnpm --dir src/web-ui run test:run src/app/scenes/settings src/infrastructure/config/components/common/ConfigLoadingState.test.tsx src/infrastructure/config/hooks/useConfigSeed.test.tsx src/infrastructure/config/hooks/useAIExperienceSettings.test.tsx src/infrastructure/config/hooks/useSelectionToolbarPreference.test.tsx src/infrastructure/config/services/ConfigManager.test.ts src/infrastructure/config/services/SettingsReadCache.test.ts src/infrastructure/config/services/AIExperienceConfigService.test.ts src/infrastructure/config/services/PermissionConfigService.test.ts
```

These tests simulate device activation and request ordering; they do not exercise
an actual SSH, relay, peer host, or detached-dispatch connection.

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

For model editor drafts and dialog presentation, run:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/modelEditorRequestSettings.test.ts src/infrastructure/config/components/subscriptionAccountState.test.ts src/infrastructure/config/components/ModelSettingsDialog.presentation.test.ts src/app/scenes/settings/pages/ai/ModelSettingsPage.presentation.test.ts
```

These checks cover draft isolation and source contracts, not rendered visuals
or remote runtime behavior.

For image-service credential reuse, subscription routing, and legacy drafts:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/image-generation/imageDialects.test.ts src/infrastructure/config/components/image-generation/imageModels.test.ts src/infrastructure/config/components/image-generation/ImageGenerationSettings.test.tsx
```

These fixtures cover imports, default selection, save failures, and simulated
device activation. They do not exercise a real provider or remote host.

For the device-scoped model catalog and non-blocking session/default selection:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/services/ModelCatalogStore.test.ts src/infrastructure/config/services/ConfigManager.test.ts src/flow_chat/components/ModelSelectorProviderLevels.test.tsx src/flow_chat/components/ModelSelectorExternal.test.tsx src/flow_chat/components/ModelSelectorAcpMode.test.tsx src/flow_chat/utils/modelResolution.test.ts src/flow_chat/services/flow-chat-manager/MessageModule.test.ts src/flow_chat/services/flow-chat-manager/SessionModule.test.ts
```

Keep warm catalogs while refreshing, invalidate them only for catalog/model
facts, and isolate all snapshots and pending work by surface activation. An
existing session commits its selection before remembering future defaults;
explicit model reads before send must not await the future-default write.

For model selection persistence and configured-channel billing annotations:

```bash
pnpm --dir src/web-ui run test:run src/flow_chat/components/ModelSelectorProviderLevels.test.tsx src/infrastructure/config/services/modelBilling.test.ts src/infrastructure/config/services/modelTags.test.ts src/infrastructure/config/components/ModelBillingDetails.test.tsx
```

Billing annotations are advisory metadata, not runtime billing or fallback
authorization. Unknown prices are not zero and subscription authentication is
not evidence of a per-token tariff. Keep the configured channel identity and
source visible, preserve unreadable records, and invalidate stale annotations
when the channel changes. The tests simulate device switches; live SSH, relay,
peer and dispatch paths require separate integration evidence.

For Router configuration writes, peer capability negotiation and protocol-test feedback:

```bash
pnpm --dir src/web-ui run test:run src/infrastructure/config/components/ModelRouterSettings.test.tsx src/flow_chat/hooks/useModelRouting.test.tsx src/flow_chat/services/sessionDraftService.test.ts src/infrastructure/api/adapters/peer-device-adapter.test.ts
```

These fixtures use mocked hosts. They do not establish connectivity to a deployed Router.
