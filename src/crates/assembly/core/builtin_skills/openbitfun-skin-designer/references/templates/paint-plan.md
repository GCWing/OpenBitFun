# Optional paint-plan worksheet

Status: draft-unverified. Adapt or replace this worksheet; it is not an import
requirement and is excluded from the ZIP. Contract fields and product anatomy
come from the target source/export, not from this table.

## Scope and chosen method

Record reference/brief, checkout/build, requested modes, whole-product or partial
coverage and chosen direction (for example color only, local material or shared
background). Explain why that direction fits the brief. A valid pack need not
use every capability, an image, a generated asset or this workflow.

## Capability facts versus design decisions

| Affected family | Verified allowed target/part/layer and source | Chosen paint/material/asset per mode | States and evidence needed |
| --- | --- | --- | --- |
| Shell / frame / chrome | Not inspected | Not chosen | Not reviewed |
| Navigation / exposed corners | Not inspected | Not chosen | Not reviewed |
| Buttons / tabs / window controls | Not inspected | Not chosen | Not reviewed |
| Fields / SearchField / picker popups | Not inspected | Not chosen | Not reviewed |
| Cards / lists / settings / notices | Not inspected | Not chosen | Not reviewed |
| Home / Agents / MiniApps / Assistants | Not inspected | Not chosen | Not reviewed |
| Tasks / calendar / Insights / Skills | Not inspected | Not chosen | Not reviewed |
| FlowChat / code / table / composer | Not inspected | Not chosen | Not reviewed |
| Requested editor / terminal / other targets | Not inspected | Not chosen | Not reviewed |

Keep only relevant rows, add others as needed, and explain exclusions. Shared
or global tokens may affect more pages than explicitly declared components.
Product-owned padding, radii, clipping, hooks and local reading planes are not
new JSON fields. Record product defects separately from package corrections.

For each chosen image, record provenance (source/generated/vector), dimensions,
frames/duration, intrinsic alpha and visible pigment bounds, target CSS size/DPR,
crop/repeat and quiet areas. Explain any authorized fidelity tradeoff. A supplied
or generated image is a choice, not a required capability.

For a shared environment, record the one shell crop and the independent
navigation/frame/reader materials. For local materials or color-only skins,
record their own decisions instead. Do not copy numerical example values as
universal opacity or readability thresholds.

During planning, identify actual rounded owners for fields/cards and existing
continuous reading regions. Calendar weekday/date material is product-owned;
check all-edge clearance and focus rings without planning layout changes in the
skin package. Headings/action containers remain transparent.
