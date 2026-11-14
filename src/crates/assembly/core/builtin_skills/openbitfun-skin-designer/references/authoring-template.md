# Optional authoring template: reference to skin

This is a method, not a capability specification. Adapt or replace it. Only
[contract.md](contract.md) and the target product determine which fields are
legal. The choices, numeric examples, worksheet names and design directions
below do not become import requirements.

## 1. Establish the brief and choose a direction

Record the requested coverage, modes, reference source and desired intensity.
Distinguish observed palette/material/rendering style from inferred choices.
Preserve component geometry, text metrics, behavior and the fixed welcome brand.

Several directions are possible within the same contract:

| Direction | Possible use of the contract | Useful review |
| --- | --- | --- |
| Color only | Mode tokens and existing semantic component colors; no assets needed | Contrast, status semantics and state feedback throughout affected views |
| Local material/artwork | Images or textures on verified surfaces/parts; independent field/card materials | Correct owner, visible motif, crop, text-safe regions and rounded boundaries |
| Continuous environment | One shell image, explicit shared-source surfaces and local reading materials | Same image origin through chrome/body, reference visibility, readable working pages |

Choose from the brief, rather than filling every available slot. A restrained
color theme is complete when that is the request. For a whole-product
reference-driven brief, show how the reference survives outside welcome;
a wallpaper alone or unrelated generic SVG ornaments may not meet that brief.
Do not require an illustration on every control or increase recipe counts as a
substitute for a coherent result.

## 2. Inspect the target and optionally create a starter

The helper requires Node.js 22.12+, a target OpenBitFun checkout with
`pnpm install` completed, and prepared design-system packages. If needed, run
`pnpm --dir <project>/src/web-ui run prepare:design-system:dev`.
Locate this Skill as `<skill>`; an installed copy need not live in the checkout.

Export current capabilities using the command in [contract.md](contract.md).
For a starter, the parent directory must already exist and the target directory
must be new:

```text
node "<skill>/scripts/visual-skin.mjs" init "<work>/my-skin" --id my-skin --name "My Skin" --project "<project>"
```

Alternatively, write canonical `skin.json` directly. `init` copies example
colors, an SVG and eight surface profiles; these are not observations from the
reference and are not mandatory coverage. Remove irrelevant profiles/assets and
change the remaining values intentionally. The helper never overwrites existing
work or output archives.

For component ids, parts, state and paint ownership, inspect the target source or
mounted DOM as well as [paint-owners.md](paint-owners.md):

```text
rg -n 'data-openbitfun-(component|product-component|scene|part|product-part|paint-layer|edge-layer|state)' design-system/packages/ui/src src/web-ui/src
```

An exported token may be unused by a specific component. A CSS class is not a
slot id. Check actual consumption before adding a recipe.

## 3. Plan materials and assets

Use [templates/paint-plan.md](templates/paint-plan.md) as a worksheet if useful.
Map palette roles, actual paint owners, source motifs, independent reading
surfaces and interaction states. Different tonal roles usually work better than
copying one dominant color into every background; preserve primary/danger,
error/success, focus, selected and disabled meanings.

For an immersive direction, a possible composition is:

- Paint the source scene once on `shell`. Explicitly share it through selected
  navigation/frame/readers using `backgroundSource: "shell"`; tune each surface's
  own material with `baseOpacity`. Other nested readers retain their bases.
- Keep toolbar and body in the same frame coordinate space. Design the crop
  around the existing centered brand and window controls. Do not move or hide
  them, reshape Hi, or remove requested light mode to make a crop work.
- Keep form groups, dense copy, cards, tables, code and overlays readable on their
  existing materials. Leave the environment visible between content regions.
  Page/section titles and their action containers stay text-only; buttons retain
  their own paint. Avoid a page-wide pale/dark veil or a new paragraph/brand slab.
- Choose appropriate foreground contrast for exposed text. A scoped
  `textShadowToken` may provide a restrained glyph shadow; it cannot rescue dense
  copy over a busy image. Do not repurpose the same shadow globally for cards.
- Match the reference's rendering style and edge softness. Prefer recognizable
  source details over inferred generic symbols. Stronger marks can occupy
  existing quiet margins; never create space by changing layout.

This is one possible method, not a required recipe. Separate local artwork and
opaque working canvases can also be intentional when requested.

### Source fidelity and image generation

Start from the supplied pixels when the brief is reference-driven. Record source
and delivered resolution, animation frames/duration, target CSS size and DPR.
Do not silently downscale, retime, shorten loops, or upscale and call it sharper.
If an asset exceeds the current limits, report the limit and proposed tradeoff.
The current package supports images, not video backgrounds.

Use an available image generator for matching raster fragments when useful.
Example requests include a sparse vertical edge, shallow toolbar ornament or
small material tile matching the reference's rendering, light and palette. Ask
for no UI/text and a quiet content area; request actual alpha for a cutout.
These are suggestions, not a required asset set or tool. Inspect output pixels,
alpha, visible pigment bounds and the final light/dark composition. Preserve
prompts/originals/provenance; do not claim a tool ran when it did not.

Do not put the full reference into every control. An asset's large transparent
canvas, low intrinsic alpha, recipe alpha and scrim can together make it invisible.
Inspect baked-in masks as well as runtime scrims; nominal opacity is not a visual
quality score. For example, image alpha 0.72 under an opaque scrim at 0.70 leaves
only 0.216 nominal image contribution before source alpha and other occlusion.

For animated assets, compressed file size is not resident memory usage. Compare
still/animated controls when performance matters; report CPU and measured memory
categories, including what was not measured. Do not set an invented universal
budget or reduce source quality as an automatic optimization.

## 4. Author only the chosen recipes

This component fragment illustrates syntax, not recommended alpha, texture scale
or mandatory components. Declare the referenced assets before using it:

```json
[
  {
    "component": "user-message-item",
    "slots": {
      "surface": {
        "assetId": "material.tile",
        "backgroundToken": "color.action.neutral.surface",
        "backgroundOpacity": 0.3,
        "backgroundSize": "180px 180px",
        "backgroundRepeat": "repeat"
      }
    }
  },
  {
    "component": "markdown",
    "slots": {
      "codeToolbar": {
        "assetId": "toolbar.motif",
        "backgroundToken": "color.surface.raised",
        "backgroundOpacity": 0.3,
        "backgroundSize": "auto 140px",
        "backgroundPosition": "right bottom",
        "backgroundRepeat": "no-repeat"
      },
      "codePre": { "backgroundToken": "color.surface.canvas" }
    }
  }
]
```

Use mode-specific token references for shared component recipes; shared literal
values can accidentally shadow every mode. Surface mode overrides replace whole
profiles by surface id, so include the complete intended profile. Token-only and
asset-free variants may omit these recipes entirely.

Keep anatomy fixes out of the skin. In the current product, the calendar's
weekday/date body is one reading plane with existing edge space. Its CSS class,
12 CSS-px paint outset and `data-openbitfun-reading-surface` hook are product
implementation facts, not fields to paste into `skin.json`. A package can choose
public material tokens; it cannot add padding or repair the renderer's clipping.

## 5. Validate, pack and inspect

Use the conformance commands in [contract.md](contract.md). Validate authoring
sources, pack to a new ZIP filename, then validate that exact ZIP. Do not patch
archive bytes by hand. `pack` includes only the canonical manifest and declared
path assets, not worksheets, screenshots or analysis.

Import into Appearance and preview. Review [visual-review.md](visual-review.md)
and optionally fill [templates/visual-review.md](templates/visual-review.md).
Inspect the actual build, package hash, requested modes and relevant states;
mount configured/populated content, not only empty pages. Do not invoke a model
just to produce screenshot data.

When a seam appears, locate the actual fill/image/edge owner, compare with the
unskinned UI, and inspect descendants, pseudo-elements, portals and retained
hidden scenes. Adjust supported tokens/assets/targets when that is the cause.
If the product paint plane violates its own shape or clips content/focus rings,
report a product defect rather than adding masks, layout fields or another image.

Use projection diagnostics in development tools if available. `projected` means
a supported declaration maps to a current target, not that it is visible or
beautiful; `inactive` means another mode/superseded declaration; `unresolved`
requires mounting the intended view/state; `unsupported` needs a corrected or
removed declaration. Release `watchProjection` subscriptions after inspection.
Do not expose these developer paths/counters on ordinary skin cards.

Deliver the validated ZIP, editable sources and honest scope/provenance/QA notes.
Keep unsupported ideas and unverified checks in the report, not invented fields.
A structurally valid package without product review is a draft, not a finished
reference-matched design.
