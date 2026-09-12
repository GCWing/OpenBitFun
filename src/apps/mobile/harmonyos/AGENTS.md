# HarmonyOS App Instructions

These rules apply to all changes under `src/apps/mobile/harmonyos`.

## Controller product boundary

Phone, tablet, and foldable entrypoints are remote controllers. They must not
instantiate a local Agent Runtime, model provider, local chat command owner, or
model configuration store. GitHub identity and the authenticated device directory
are the authority for selection and reconnect; QR data supplies only a device id.
Keep old persisted records readable and retained without activating legacy room
credentials or local execution. Compact and wide hosts enforce the same boundary.

## MVVM Refactor Boundaries

This app has one `entry` module, so MVVM is the file-organization boundary for
the module. Keep the official responsibilities explicit:

- Model/services own data access, persistence, transport, and business logic;
  they do not import views or page components.
- Views own presentation and user input; they consume projected state and emit
  intents/events rather than calling services directly.
- ViewModels bridge services and views by owning feature state, projecting data,
  and handling intents. ViewModels must not import components.
- Shared conversation presentation DTOs (`ChatSurface`, `ChatComposerCapabilities`,
  `ConversationUiModels`) live in `pages/state/`. State must not import
  `pages/components`.

The following constraints are enforced incrementally by
`pnpm run harmony:architecture` (the runtime behavior checks remain in
`entry/src/test/ArchitectureUnit.test.ets`):

1. `services/**` must not import `../pages/`.
2. `pages/state/**` must not import `pages/components/`.
3. `pages/components/**` must not import `pages/viewmodel/`; imports of
   `pages/state/` and `pages/policy/` are allowed for observable state and pure
   policies.
4. The page dependency graph must remain acyclic; ViewModels must not depend on
   components.
5. Actions and Hooks use typed interfaces with object literals. Do not add
   position-dependent callback constructors.
6. New components use `@ComponentV2`; do not add V1 `@Component`, `@State`,
   `@Prop`, `@Link`, or `@Watch` declarations. `@BuilderParam` remains supported.
7. General Chat and Remote Chat shared observable fields belong to
   `pages/state/ConversationCoreState.ets`. Page-specific state objects compose
   that core and must not redeclare the shared `@Trace` fields.
8. Keep files focused by ownership, not by a hard line count. When a file
   starts mixing unrelated concerns, extract the new owner. Do not cram or
   flatten structure just to stay under a number.
9. Components must not import permission, scanner, input-method, or other
   side-effectful platform kits directly. Put platform lifecycle and error
   handling behind a service or a focused platform leaf component, then expose
   typed state and events to the presentation tree.
10. Long, unbounded timelines use `Repeat.virtualScroll()` with stable identity
    keys. V2 message rows must remain reusable, and mutable render content must
    not be embedded in the identity key.
11. CPU-bound native work must not execute synchronously on the ArkTS caller
    thread. Expose it through Node-API async work (or an equivalent TaskPool /
    Worker owner), return a Promise, and bound the ArkTS wait with an explicit
    timeout.
12. `ConversationView` consumes grouped presentation state/options and emits a
    typed `ConversationIntent`. Do not reintroduce one public parameter or event
    per projected field/action.

User-facing copy lives in `entry/src/main/ets/i18n`. Keep `zh-CN` and `en-US`
catalogs in key lockstep, use canonical locale ids, and route language changes
through `LocaleController`. Do not import Web UI or mobile-web locale catalogs.

The current local HarmonyOS verification loop is:

```bash
node --test miniapps/*.test.cjs  # bundled sources, browser bridge, and local storage compatibility
source scripts/ohos-env.sh
"$HVIGORW" --mode module -p product=default -p module=entry@default assembleHap --no-daemon
"$HVIGORW" --mode module -p module=entry@default -p ohos.test.type=LocalTest test --no-daemon
```

## Visual reference fidelity

- Before drawing a system glyph, text approximation, or new bitmap, search the existing HarmonyOS media resources and the approved desktop reference images. Reuse the established asset when one exists.
- Conversation header controls must use the approved `remote_ref_back` and `remote_ref_more` assets. Do not replace them with a system chevron or text such as `...` / bullet characters. Compact top-left open-sidebar uses `CompactMenuButton` (`gpt_home_menu_glyph`). Wide restore/collapse uses `SidebarToggleButton` (the sidebar-pane glyph).
- Render monochrome reference assets in template mode and tint them with semantic theme colors such as `INK`. Never rely on the bitmap's original black or white pixels; the same control must remain legible in light and dark themes.
- Keep paired header controls on the same fixed touch-target size and optical alignment. A responsive layout may reposition a control, but must not silently change its icon geometry or visual weight.
- Keep `SymbolGlyph` geometry separate from its touch target. When a glyph is clickable or sits in a decorated control, wrap it in `Stack({ alignContent: Alignment.Center })` (or use a centered `Button`) that carries the touch-target size, and size the glyph with `.fontSize()` only. Do not stretch the glyph itself to the full 32vp/40vp/44vp target.
- Prefer `.fontSize()` over `.width()`/`.height()` on a `SymbolGlyph`. Measured on device: a glyph's natural advance box is `fontSize * 1.013` square for most symbols, but `chevron_left` and `chevron_right` are only `fontSize * 0.507` wide. Ink is drawn **left-anchored** inside any box forced wider than the natural box (vertically it stays centered, so only the horizontal axis is affected), and a box forced *smaller* than the natural box makes the glyph overflow rather than scale. So `.width(N)` on a chevron shifts it left of its container's center by `(N - fontSize * 0.507) / 2`.
- A collapse indicator that swaps between `chevron_right` and `chevron_down` still needs a fixed slot so the adjacent label does not jump between states. Put the fixed size on a wrapping `Stack({ alignContent: Alignment.Center })` and select the symbol with a ternary on one unsized `SymbolGlyph`; see `SubagentTaskCard.ets`. Never put the slot size on the glyph itself.
- The one place a forced width is correct is a leading icon slot in a list row: because ink is left-anchored, a shared `.width()` is what keeps icon and text left edges aligned down a column of rows whose `fontSize` values differ. Leave those alone.

## Responsive interaction semantics

- Every HarmonyOS change that can affect presentation or interaction — including
  state, actions, ViewModels, and components — must treat compact phones, wide
  screens, and foldables in both folded and unfolded postures as first-class
  targets. Do not implement or review a feature against only the currently
  visible layout.
- Before editing, search for every responsive host and presentation branch that
  exposes the affected action or state (for example compact overlays, wide
  master/detail hosts, sidebars, routed destinations, sheets, and popovers).
  Keep their behavior and capability gating aligned; a fix is incomplete while
  an equivalent wide or compact entry point still uses legacy behavior.
- Do not infer device class from a single width captured at startup. Layout must
  remain correct when a foldable changes posture or window size while the app is
  running, preserving state, selection, and interaction meaning across the
  transition.
- For UI changes, verify at minimum one compact layout and one wide layout. When
  a foldable or resizable emulator/device is available, also exercise a live
  folded/unfolded or resize transition. Record any unverified posture explicitly
  in the handoff instead of treating a phone-only check as sufficient evidence.
- Wide and compact layouts must keep the same interaction meaning. Responsive presentation may change spacing and available width, but it must not turn a lightweight anchored action menu into a bottom sheet by default.
- Conversation-header overflow actions open from the top-right trigger as an anchored popover on both compact and wide layouts. Use a bottom sheet only when the content is a genuinely large or multi-step mobile workflow and the design explicitly calls for it.
- Anchor popovers to their actual trigger with `bindPopup` or the equivalent platform API. Do not emulate the anchor with unrelated page-level absolute positioning.
- Preserve auto-dismiss, outside-tap handling, accessibility labels, and a short enter/exit transition for anchored menus.

## Theme and device verification

- Use existing semantic colors from `Theme.ets`; do not hard-code a light-only foreground or surface color.
- For changes to navigation controls, menus, or responsive presentation, verify compact and wide behavior, light and dark theme legibility, and capture a real-device screenshot before completion when a device is connected.
- Run the smallest matching HarmonyOS build/check plus `pnpm run theme:color-audit:all` for theme or color-related changes.
