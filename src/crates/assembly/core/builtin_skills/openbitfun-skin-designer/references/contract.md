# Import contract: what a skin can change

The authority is `src/web-ui/src/infrastructure/visual-skin/{types,contract,
validator,parser,runtime}.ts` and `src/web-ui/src/app/styles/visual-skin.scss`
in the target checkout. Use `scripts/visual-skin.mjs contract` to inspect its
public ids. This reference describes canonical packages, not a second schema.
It specifies capabilities and import constraints, not a preferred visual design.
The optional [authoring template](authoring-template.md) does not override it.

## Modification scope

| Area | A package can change | Product-owned boundary |
| --- | --- | --- |
| Theme/material | Exported paint tokens: semantic/component colors and public color/shadow tokens | No font metrics/families, spacing, radius, dimensions, layout or motion overrides |
| Existing surfaces | Base material, one backdrop, one scrim, supported image fit/position/alpha, local tokens and supported states | No new surfaces, arbitrary layer stacks, clipping or content geometry |
| Existing components and owned parts | Supported background assets/material, foreground, existing border color, box/glyph shadows and emitted states | No arbitrary selectors, DOM changes, icon/text replacement, hiding, repositioning or new behaviors |
| Assets | Local PNG/JPEG/WebP/SVG, including supported animated image content | No external URLs, scripts, video backgrounds or font installation |
| Modes | Any nonempty subset of the four supported modes, with documented fallback/merging | A fallback is not a separately authored mode; requested coverage is a user requirement |

Assets, component recipes and explicit surface profiles are optional. A valid
package may change only paint tokens. No palette, illustration density, generated
asset set, shared-wallpaper method or specific component coverage is imposed by
the import format. The user brief and visual review determine design completeness.

Export the current capability set before authoring:

```text
node "<skill>/scripts/visual-skin.mjs" contract --project "<project>" --out "<work>/contract.json"
```

The helper needs Node.js 22.12+, installed checkout dependencies and prepared
design-system packages. The export lists exact tokens, fixed surfaces, field
allowlists, global slots and common states. Component ids and owned parts must
also be checked in the target source or mounted DOM; the export is not an
exhaustive component catalog. Token existence does not prove CSS consumption.

## Manifest and modes

The ZIP root contains `skin.json`:

```json
{
  "manifest": {
    "schema": "openbitfun.visual-skin",
    "schemaVersion": 1,
    "id": "my-skin",
    "name": "My Skin",
    "version": "1.0.0"
  },
  "modes": {
    "light": {
      "tokens": {
        "color.surface.canvas": "#f7f4ee",
        "color.content.primary": "#202636"
      }
    }
  }
}
```

`schemaVersion` is the parser's format identifier. Do not invent alternate
generations of the skin system. Optional manifest keys are `author`,
`description`, and `previewAssetId` (a declared image id). Ids use lower-case
letters/digits with `.`, `_`, or `-` separators; manifest id is at most 96 chars.
`name` and `version` are non-empty strings of at most 160 chars.

Mode keys are exactly `light`, `dark`, `highContrastLight`, `highContrastDark`.
At least one is required. Standard modes select themselves, then the opposite
standard mode, then matching and opposite high-contrast modes. A high-contrast
request uses its matching standard mode as base when present, then the opposite
standard mode, then matching/opposite high-contrast modes, and overlays its own
patch. Tokens merge by token name. Mode `slots` merge by whole slot id: an
override replaces that slot's entire declaration map, not individual properties.

Mode patches also accept `surfaces`, with the same profile shape as root
`surfaces`. Resolve shared profiles, then the fallback base mode's profiles,
then the requested mode's profiles. Match by surface id and replace the whole
profile; omitted fields are cleared, not inherited from a replaced profile.
Other surface ids stay selected. Runtime, diagnostics, and authoring composition
reports use the same resolver. Inactive/superseded profiles are not projected.

Token values are strings or finite numbers. Use exact paint token ids from the
exported `contract` output; guessed alternative names are not aliases. Values cannot contain `url(...)`, `var(...)`, expressions, semicolons,
braces, or markup. Only semantic/theme colors, component color aliases, and
public color/shadow system tokens are supported. Typography metrics, radius,
spacing, layout, control dimensions and motion tokens are rejected. Components
retain their original shape, size and position. Paint tokens do not authorize
arbitrary CSS or guarantee every renderer uses them. Use valid CSS units and
values for the target property. The validator does not measure visual contrast
or prove browser consumption of a syntactically safe string.

## Assets

```json
{
  "assets": {
    "paper.texture": {
      "mimeType": "image/webp",
      "source": { "kind": "path", "path": "assets/paper.webp" },
      "alt": "Subtle paper grain"
    }
  }
}
```

Supported MIME types are `image/png`, `image/jpeg`, `image/webp`, and
`image/svg+xml`. A ZIP may use path assets or embedded data assets. Standalone
JSON requires `source: { "kind": "data", "data": "data:image/webp;base64,..." }`.
Paths are relative POSIX paths inside the skin directory; no traversal, absolute
paths, remote URLs, or escaping symlinks. Every file must exist and every asset
reference must resolve. Keep SVGs self-contained; do not embed scripts, HTML,
external resources, or font files. Provenance, licensing, dimensions, and safe
areas belong in the accompanying analysis, not invented manifest keys.

Current importer limits: 32 MiB input, 96 ZIP entries including directory entries,
16 MiB per expanded entry, 48 MiB expanded total, and 512 KiB for `skin.json`.
The packer emits no directory entries. JSON-only imports also have the 512 KiB
manifest limit. The production parser checks bounded extraction and CRC; it
does not certify asset licensing, raster identity, or aesthetic suitability.

## Surfaces

Fixed surface ids: `shell`, `workbench`, `workbench-content`, `navigation`,
`chat`, `editor`, `terminal`, `empty-state`. Each entry in `surfaces` accepts:

| Field | Meaning |
| --- | --- |
| `surface` | Existing product-owned surface id. |
| `baseToken` | Public token id providing the base fill. When omitted, `contract` exports the product's `surfaceBaseTokens` defaults. |
| `backgroundAssetId` | Declared backdrop asset id. |
| `backgroundSource` | Optional `"shell"`: reveal the single shell backdrop in its existing coordinates. Cannot combine with a local backdrop/fit/position/opacity, or use on shell itself. Requires visible shell artwork in the selected mode. |
| `baseOpacity` | Number 0–1, default 1. Changes base material alpha only; content, borders, hit targets and geometry remain unchanged. A shared source without available shell artwork keeps the opaque fallback and reports its unavailable dependency. |
| `fit` | `cover`, `contain`, or `fill` (stretch to `100% 100%`); requires a backdrop. |
| `backgroundPosition` | One or two position keywords or percentages; requires a backdrop. No pixel offsets. |
| `backgroundOpacity` | Number 0–1 affecting only the backdrop; requires a backdrop. |
| `scrimToken` | Public token id for the scrim color. |
| `scrimOpacity` | Number 0–1; requires `scrimToken`. Default 0: tinting is explicit. |
| `tokens` | Public-token value overrides scoped to this surface. |
| `states` | State recipes using the shape below. |

Base → backdrop → scrim → existing content is fixed by the product. Surfaces
have one backdrop and one scrim, not arbitrary material stacks, blend modes,
responsive layers, content-safe-area objects, or user-defined clipping rules.
Child panels can obscure parent artwork. Transparent paint tokens need actual
product inspection; the skin does not replace
the component tree. No new text, layout, or product copy is injected.

The surface base stays on its actual product boundary; a reserved child paint
plane clips backdrop and scrim to that boundary's radius. The runtime does not
reuse a component's existing pseudo-elements or change its overflow/position.
Navigation owns the full sidebar including history controls. Workbench-content
owns the complete rounded frame including the top toolbar; structural header
fill is transparent inside that profile. A product-owned navigation underlay
uses the selected navigation base (including local tokens) behind scene corners.
Shared-shell navigation extends the same base alpha over the same shell pixels
at those corners, so the original rounded frame remains visible without a color
seam. Collapsed navigation reveals the shell instead. This changes paint, not radius or component placement.
The underlay follows the actual scene edge through navigation collapse and live
resize; it adds no second backdrop or scrim. Top controls use chrome material
unless the frame explicitly owns artwork. Undeclared working surfaces keep
semantic reading bases. Shared-shell profiles explicitly reveal ancestor artwork
through the frame's toolbar/viewport chain. They do not clear independently
painted readers, menu/popover surfaces or settings roots.
Explicitly declared child profiles retain independent fill and layers. The
workbench-content frame exposes the existing `empty` state when no tab is active.
State token recipes can scope landing-only paint. A shared settings page
can explicitly scope `color.surface.scene` to `transparent` on `config-page`
while keeping its section/field/overlay materials independent.

Chat surfaces paint the conversation canvas, not the input wrapper. Editor
artwork opts the known code-editor paint chain into transparency while an image
is visible; headers, menus, selections, widgets and other panel types retain
their backgrounds. A parent workbench image can still be occluded by a scene:
do not claim it decorates the scene's components without checking that view.

## Global slots

Each mode may also provide `slots: { "navigation-background": { ... } }`.
Supported ids: `shell-background`, `workbench-background`,
`workbench-content-background`, `navigation-background`, `chat-background`,
`editor-background`, `terminal-background`, and **`empty-state`** (no suffix).

Supported properties: `background-color`, `background-image`,
`background-position`, `background-repeat`, `background-size`, `foreground`,
`border`, `shadow`. `foreground` sets text color, `border` sets border color
(not width/style), and `shadow` sets box shadow. Values are literal safe CSS
values subject to the token-value restrictions. For images use a surface
`backgroundAssetId`; `background-image` cannot bypass URL restrictions. These
slots are different from component named parts.

## Components, owned parts, and states

```json
{
  "components": [{
    "component": "button",
    "tokens": { "color.border.default": "#90784B" },
    "states": {
      "disabled": {
        "slots": { "leading-icon": { "foregroundToken": "color.content.muted" } }
      }
    }
  }]
}
```

`component` matches an existing `data-openbitfun-component` or
`data-openbitfun-product-component`, or `data-openbitfun-scene` id. Existing
scene parts such as `welcome.title` and `personal-overview.identity` use this
same bounded recipe shape. Component entries accept only `component`, `tokens`,
`slots`, and `states`. Product layout and the welcome brand's centered position
are fixed; recipes cannot move or hide them. Unsupported component fields fail
validation. The empty welcome can reveal shell artwork; other undeclared child surfaces
keep semantic reading bases. Explicit local profiles and surface-local base
tokens control independent material. Child surfaces never repeat the ancestor
image automatically. Cards and interactive controls retain their own fills.
Parts in `slots` match
`data-openbitfun-part` on the owner itself or its descendants, stopping at nested
component/surface boundaries. Button currently exposes `root`, `progress`,
`content`, `leading-icon`, `label`, and `trailing-icon`; conditional parts may
not be mounted. Do not infer parts of another component from these names.
Use exact product spelling for parts, including camelCase names such as
`chat-composer.contextBar` and `config.pageHeader`. This does not change the
lower-case id requirement for components, surfaces, global slots or assets.

A part recipe accepts only these paint fields:

| Field | Meaning |
| --- | --- |
| `assetId` | Declared image id; `null` explicitly clears the base image in a state. |
| `fit` | `cover`, `contain`, or `fill`; mutually exclusive with explicit size. |
| `backgroundSize` | One or two `auto`, positive px (up to 4096), or percentages (up to 400). |
| `backgroundPosition` | One or two bounded keywords/percentages, like surface focal position. |
| `backgroundRepeat` | `no-repeat` (default), `repeat`, `repeat-x`, `repeat-y`. |
| `backgroundOpacity` | Image-only alpha from 0 to 1. Requires an image and an opaque `backgroundToken`. |
| `backgroundToken` | Public color token for the part's base material. |
| `textShadowToken` | Optional public `shadow.*` token emitted as `text-shadow` on glyphs. Supply a CSS text-shadow-compatible value (no inset/spread), or `none` to clear it. No backdrop, box shadow, geometry or opacity changes. |
| `foregroundToken` | Public color token for text/icons. |
| `borderToken` | Public color token for existing borders; no new border width/style. |
| `shadowToken` | Public `shadow.*` token for existing box paint. |

No element `opacity` field is supported. Text and children never fade to tint a
material. Image-only alpha is composed as a base-colored veil over the image on
that part's opaque base, preserving image dimensions and independent repeat.
Use intrinsic transparent assets when retaining the product's variant-specific
fill. An opaque `backgroundToken` replaces that fill: preserve primary/danger,
error/success and disabled semantics rather than painting every action alike.

State part fields merge over that part's base recipe. Geometry remains fixed.
An omitted image continues the base image; `assetId: null` removes it. State-only
size/alpha overrides may use the image/base token from the base part. Unknown
fields, CSS fragments and layout declarations are rejected, not silently ignored.

An owner without an explicit part marker exposes its implicit `root` (for example
Menu/Input/Card). Explicitly named owner parts retain their own id. Backgrounds
follow the product's `data-openbitfun-paint-layer`: native button/tab `::before`
paint remains under content and keeps its existing radius, stacking and hit area.
It adds a background image; it never replaces icon DOM or product pseudo-elements.
Borders and shadows follow `data-openbitfun-edge-layer="before"` when the product
owns them on that layer (TabGroup's expanding tab surface). Otherwise they remain
on the part itself, as with Button. These anatomy hooks are product-owned; skin
authors must not add or override them.

Both components and surfaces may have `states: { "<state-id>": { "tokens": {},
"slots": {} } }`; each state recipe uses those same token and part shapes.
States follow product `data-openbitfun-state` plus the native/ARIA mappings in
`contract.ts`. Use `contract` to inspect common ids, then verify that the target
actually emits the desired state. Part paint also follows its own/nearest owned
part's state, so `tab-group.states.selected.slots.tab` matches the selected tab
and `slots.label` follows that tab. It stops at nested component boundaries.
State token maps themselves remain owner-scoped; use part token references for
child-state paint. Diagnostics use the same ownership/state rules as compilation.
Switch checked state follows its direct native role=switch input. A safe state id that is never emitted has no
effect. States cannot add behavior. Recipes outside `modes` are shared by all
modes; literal recipe token overrides can shadow the selected mode's root tokens.

There are no arbitrary selectors, CSS/JS, keyframes, component variants, layout
overrides, responsive recipe rules, text layers, font installation, or network
assets. Existing Monaco/xterm/Mermaid/widget/canvas adapters own their rendering;
token projection is not a promise of arbitrary renderer decoration.


## Product-owned reading planes

`data-openbitfun-reading-surface`, `paint-layer`, `edge-layer` and CSS class names
are product anatomy, not authorable JSON keys or permission to inject CSS.
Local reading planes preserve the product's existing shape and interaction
bounds. The calendar's continuous weekday/date plane and gutter space are
implemented in the product; the package can supply supported material tokens,
not padding, geometry, or a new `calendar-body` slot. See
[paint-owners.md](paint-owners.md) for current owner notes.

## Package conformance and output

A canonical ZIP has `skin.json` at its root and declared relative assets, with no
enclosing skin directory. Standalone canonical JSON can be imported when every
asset is embedded and its bytes fit the manifest limit. Worksheets, provenance,
analysis and visual reports are not importer fields or required archive files.

```text
node "<skill>/scripts/visual-skin.mjs" validate "<work>/my-skin" --project "<project>"
node "<skill>/scripts/visual-skin.mjs" pack "<work>/my-skin" --out "<work>/my-skin.zip" --project "<project>"
node "<skill>/scripts/visual-skin.mjs" validate "<work>/my-skin.zip" --project "<project>"
```

Directory validation and packing build the same ZIP and run the production
parser, including bounded extraction and CRC. The authoring lint additionally
rejects unknown/ignored fields, duplicate targets and invalid dependencies;
this is a stricter new-package authoring check, not a new runtime schema.
Packing includes only `skin.json` and declared path assets. It writes a new output
file, never overwrites an existing archive, and never imports/activates a skin.

The helper's `validation` result certifies this structural check only. It leaves
projection and visuals unverified and reports `deliveryStatus: draft-unverified`.
Importability does not certify contrast, source fidelity, memory cost or visual
quality. Inspect the exact delivered archive in the product using
[visual-review.md](visual-review.md) before claiming those outcomes.
