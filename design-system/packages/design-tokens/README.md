# @openbitfun/design-tokens

Framework-neutral token contract and system scales for OpenBitFun UI packages.

This package intentionally contains no concrete brand palette. Install a theme package such as `@openbitfun/theme-openbitfun` alongside it.

```ts
import {
  cssVariables,
  tokenCatalog,
  tokenModes,
  tokens,
} from "@openbitfun/design-tokens";
import "@openbitfun/design-tokens/tokens.css";
```

Only semantic and system token names are public API. Density modes reuse the same names and override values through a scoped `data-density` attribute.

`tokenCatalog` is the authoring contract for visual tools. Each entry exposes its type, CSS variable, category, description, and resolved value in every density mode. Applications normally consume `tokens`; editors consume the catalog instead of maintaining a second token list.

`motion.duration.contentSwap` (320ms) gives `RollingText` one cadence for vertical
line travel and intrinsic-width changes. It has its own token so tuning content
replacement does not change the existing hover-feedback and larger-view
transition durations. It is zeroed in the reduced-motion projection.

## Overlay layers

Portaled tooltips must paint above the popovers containing their triggers.
Use `layer.popover` for menus and panels, with adjacent offsets for their
backdrops (-1) and nested menus (+1); keep those offsets below `layer.tooltip`.
Toast, notification, and context-menu layers remain above ordinary hover hints.
These values order siblings within a stacking context; a portal host still
needs its own layer above the app content it serves.

## Semantic typography roles

Text-bearing components consume a complete semantic role rather than assembling
font family, size, weight, line height, and letter spacing from foundation
tokens. The core interface roles are:

| Content purpose | Token role | Default contract |
| --- | --- | --- |
| Page title | `type.heading.page` | Control, 24px, 700, 1.2, normal |
| Compact page title | `type.heading.compactPage` | Control, 20px, 600, 1.2, normal |
| Panel title | `type.heading.panel` | Control, 18px, 600, 1.2, normal |
| Navigation title | `type.heading.navigation` | Control, 17px, 600, 1.2, normal |
| Section title | `type.heading.section` | Control, 15px, 600, 1.2, normal |
| Card title | `type.heading.card` | Control, 13px, 600, 1.2, normal |
| Body copy | `type.body.sm` | Sans, 13px, 400, 1.5, normal |
| Large body copy | `type.body.lg` | Sans, 15px, 400, 1.6, normal |
| Supporting text | `type.support` | Control, 11px, 400, 1.55, normal |
| Control label | `type.label.md` | Control, 13px, 400, 1.2, normal |
| Selected control label | `type.label.selected` | Control, 13px, 600, 1.2, normal |

Use every property from the selected role so localization, platform font
fallbacks, density, and the runtime font-size preference remain synchronized:

```css
.title {
  font-family: var(--openbitfun-type-heading-card-font-family);
  font-size: var(--openbitfun-type-heading-card-font-size);
  font-weight: var(--openbitfun-type-heading-card-font-weight);
  line-height: var(--openbitfun-type-heading-card-line-height);
  letter-spacing: var(--openbitfun-type-heading-card-letter-spacing);
}
```

Foundation variables such as `--openbitfun-font-size-sm` remain available for renderer
adapters and non-text geometry. Public text components should use `--openbitfun-type-*`
roles.

When an existing composition intentionally overrides only line height or
tracking, use `type.modifier.leading.*` or `type.modifier.tracking.*` on top of
its established role. `type.overline.*` owns extra-small uppercase annotations;
these modifiers keep product styles semantic without changing their resolved
metrics during migration. `type.modifier.leading.support` provides the compact
1.45 supporting-text rhythm used when an 11px role must align to a 16px line.
`type.modifier.leading.tight` provides 1.2 leading for compact message bubbles:
18px at the default 15px body size, scaling with user typography preferences.
`type.modifier.leading.intrinsic` uses `normal` for the inner single-line text
box in `OverflowText`. The browser includes the selected font's ascent/descent;
existing numeric leading roles cannot express those platform-dependent metrics.
The outer line box retains any larger leading supplied by its owning control.

`layout.searchDialog` owns the shared Lab/product search composition: 800 × 460
when space permits, 20px inset and query-to-scope gap, and a 30px query row.
Only the query shell scopes `control.searchField.height.sm`; general Input and Button sizes
retain their defaults. Results scroll within the available viewport.

## Search geometry

`control.searchField.height.sm/md/lg` owns search input-row layout heights.
These alias `control.height.sm/md/lg`, except compact `sm` is 30px to preserve
the original search component's 22px action and 4px top/bottom/end clearance.
The generic compact input remains 28px. This separate owner is necessary because
changing the generic height would resize unrelated controls.
SearchField draws a centered decorative outline outside the layout calculation;
action clearance is derived from row height and `control.iconButton.xsSize`.
Spacing and action shape reuse the existing system scales. Density overrides
and Design Lab edits therefore update geometry without product-specific CSS.
