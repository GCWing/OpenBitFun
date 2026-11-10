# Aurora Paper authoring example

This is a starter based on a written direction, not a reconstruction of an
external reference image. Replace its palette and artwork for a real request.

## Design mapping

| Direction | Canonical output |
| --- | --- |
| Warm paper and indigo ink | `color.surface.*`, `color.content.*`, `color.accent.*` values for light and dark. |
| Distinct persistent planes | Separate canvas, scene, panel, raised, chrome, and tertiary colors. |
| Indigo text actions | Mode-specific `component.button.textContent` and `component.button.textContentHover`. |
| Quiet illustration behind the empty state | `surfaces[empty-state]` references `brand.mark`, using contain fit, centered placement, image opacity 0.1, and panel-color scrim opacity 0.4. |
| Conditional disabled icon treatment | A `button` disabled-state part recipe uses `leading-icon.foregroundToken` for muted color; requires an icon-bearing disabled Button in the current view. |

The other seven surfaces only bind their base fill. Their existing boundaries
and radii are preserved. The package does not introduce text layers, responsive
layout, safe-area fields, custom clipping, or logo replacement. A background
image on a part is decoration, not replacement of its existing markup.

## Asset provenance

`brand.mark` is the original example SVG at `assets/aurora-mark.svg`, with a
64 × 64 viewBox. It depicts an indigo arc and mint dot. The preceding example
catalog declared this artwork CC0-1.0; this record preserves that declaration,
not an independently verified license. No image generator was run in this
update. The asset can also appear as the settings preview via `previewAssetId`.

## Validation and remaining checks

The production parser and authoring-tool tests exercise canonical packaging,
exact public tokens, asset resolution, supported surface ids, and mode values.
`reference-analysis.md` is explanatory material; the packer excludes it from
the import archive.

Projection, real product rendering, and composed contrast are **unverified** for
this starter. Check wide/compact navigation, chat, editor, terminal, and empty
state in both light and dark modes. For the optional button part recipe, mount
a disabled button with a leading icon. Inspect edges, nested surfaces, menus,
focus, and text over the composited empty-state image. Record screenshots and
measured contrast before claiming visual acceptance.

High-contrast patches are not designed. The runtime can fall back to these
standard palettes, but this example makes no high-contrast accessibility claim.
