# @openbitfun/theme-openbitfun

Replaceable OpenBitFun theme values for the framework-neutral `@openbitfun/ui` package.

```ts
import "@openbitfun/theme-openbitfun/default.css";
import { themeModes, themeTokenCatalog, themes } from "@openbitfun/theme-openbitfun";
```

`default.css` synchronously imports the system token contract and all built-in theme variants. Theme selection is scoped to a `data-openbitfun-design-system-root` element and uses independent `data-color-scheme` and `data-contrast` axes.

`themeTokenCatalog` exposes the complete public semantic theme contract for visual authoring: colors, elevation shadows, surface filters, and state opacity. UI components consume this semantic contract and never depend on reference colors directly.

`effect.blur.strong` provides 32px blur and 1.3 saturation for translucent floating
panels such as Global Search. The existing 12px `medium` filter leaves detailed
content too distinct at lower surface opacity; its smaller blur remains appropriate
for compact controls. The stronger role lets panels widen their blur radius
independently and retain opaque high-contrast and reduced-transparency fallbacks.

## Foundational color scales

Named numeric scales live below the semantic theme layer. Step numbers increase from light to dark, for example `ref.color.neutral.50`, `ref.color.blue.500`, and `ref.color.red.700`. Semantic tokens map those stable palette values to roles such as `color.content.primary` or `color.status.danger.content` independently in each theme mode.

Design tools can read the palette through the authoring-only export:

```ts
import {
  referenceColorCatalog,
  referenceColorScales,
} from "@openbitfun/theme-openbitfun/authoring";
```

The same data is available as `@openbitfun/theme-openbitfun/reference-colors.json`. Reference colors deliberately do not emit runtime CSS variables; application and component CSS must continue to use semantic theme variables.

## Surface and state roles

`color.field.*` owns shared field surfaces and state borders. Light uses neutral
8% borders, with 20% hover and active Input/SearchField borders. The dedicated
`color.field.borderActive` owns the editing border because Input's design differs
from the stronger focus treatment used by other controls. These text
fields use one unchanged border for both pointer and keyboard focus; native
`:focus-visible` must not substitute the stronger generic focus palette or add
a second ring. Dark and high-contrast modes retain their own focus color, and forced
colors use Highlight. `color.field.borderFocus` retains its 3:1 contract for
other controls that consume that stronger focus treatment.
`color.field.placeholder` separates
40% empty hints and decorative adornments from general secondary prose; dark
and high-contrast modes retain their readable muted content colors. The default
light Web UI consumes these published values in root and chrome scopes. Named
presets keep their own palette, and imported packages that only supply
`color.content.muted` retain that field hint color unless explicitly overridden.
Old packages that supply `color.field.borderFocus` retain that editing border
unless they explicitly provide `color.field.borderActive`.

`component.button.*` owns Button's state palette. Its light fill stays at black
8% while the shared neutral actions retain their 5/8/10% feedback; its primary
background uses black 80/60/90% and disabled content 20%. Outline and text variants
composite directly over the caller's surface. These differences cannot be
represented by changing the shared action palette without changing menus,
IconButton, and other controls. Dark and high-contrast mappings retain their
mode-specific feedback and outline contrast. Color entries remain editable in
Design Lab's Colors catalog; Button geometry is independent of this palette.

`component.empty.media` owns the low-emphasis color for decorative Empty
artwork. It resolves to an opaque neutral in every mode because Lucide icons can
contain overlapping paths; reusing translucent disabled-content colors would
make those intersections visibly darker. The color matches muted content at 35%
over the tertiary empty-state surface, while `layout.empty.*` owns the reference
10px rhythm, 32/16px padding, and 24/32/40px media sizes.

The default Web UI appearances consume these published component values.
Branded presets and imported appearances may still supply the existing action
tokens: the Web UI inherits explicit old values only when the corresponding
component token is absent, and keeps explicit component overrides intact.

- `color.surface.scene`, `panel`, and `raised` own primary content and elevated planes.
- `color.surface.chrome` owns persistent application structure such as navigation and window-control regions.
- `color.surface.tertiary` is an opaque low-emphasis fill for persistent containers such as cards.
- `color.field.groupBackground` owns grouped form surfaces: light mode uses a 3% black tint so the underlying surface remains visible; dark and high-contrast modes retain their tertiary fill. Opaque tertiary containers and transient `surface.subtle` feedback cannot express this form-specific contract. Imported appearances inherit an explicitly supplied legacy tertiary color unless they supply the new field token.
- `color.surface.subtle` is a translucent local tint for transient feedback and small inset details. It must not define a persistent application plane.
- `color.selection.surface` owns persistent neutral selection. Hover and pressed colors remain action feedback and are not substitutes for selection.
- `color.codeChange.added` (`#1aa73e`) and `color.codeChange.removed` (`#ec221f`) also anchor success and danger emphasis. Warning emphasis uses `#ff8c00`; information uses the existing creative-action blue (`#2e7eff`). These clear hues share light tints instead of separate per-component palettes.
- `color.status.*.emphasis` colors icons and short emphasis. `content` derives a readable shade from that anchor for text; `surface` and `border` derive 10% and 30% tints. High-contrast themes may strengthen text contrast without changing the emphasis anchors.
- Status source tokens retain their `color-mix()` references. The theme build resolves these mixes to concrete hex/RGBA values so CSS, plugins, and renderer payloads consume the same palette without relying on renderer-specific CSS color support.

`color.content.caption` distinguishes low-emphasis menu/navigation group headings
from body descriptions and input placeholders. Light mode supplies final black
40%; dark and high-contrast modes reuse readable muted content. An imported
appearance's explicit old muted color is retained when the caption token is absent.
The built-in light Appearance preserves the public neutral action content (80%)
in both root and chrome; generic palette projection previously reduced product
menu labels to secondary text (60%). Explicit imported action colors still win.

Action cards own `color.actionCard.background`: the light entry surface is black at 3% opacity. `surface.subtle` is a transient navy tint and `field.groupBackground` belongs to form groups, so neither represents this persistent action surface. Other modes retain their neutral action surface. Product Appearance preserves explicit legacy neutral-surface overrides in root and chrome.

Compact indicators own `color.numberBadge.background` and `color.keyHint.content` so reference light values (8% fill and 60% text) can coexist with existing dark/contrast values and explicit legacy Appearance overrides. The light Switch off track uses 10% black; scrollbar thumbs use 20% at rest and 30% on hover so their state change stays visible without a harsh contrast jump. KeyHint and Launcher resting fills use 8%. Long status labels keep content colors; StatusPill emphasis is opt-in.

`color.composer.border` and `color.composer.contextBackground` are the shared editor-surface contract for Composer and ChatComposer. Reference light uses an 8% border and 3% context tint; persistent entry cards and form groups keep their separate owners. Legacy explicit field-border and subtle-surface overrides populate the new keys only when absent. Composer shadow uses a 12px CSS box-shadow blur (the Figma effect radius; its generated filter drop-shadow uses a 6px standard deviation).
