---
name: create-visual-theme
description: Create or update an importable OpenBitFun visual skin from reference images or an art brief, using the target product's actual paint contract and checking the result in the existing UI.
---

# Create an OpenBitFun visual skin

Create `skin.json` and local assets for the existing product. Keep two questions
separate: **what the package can change** and **which design method to use**.
The contract determines importable fields. A template suggests one way to use
them; it neither expands nor narrows the contract.

## Read the contract first

Read [references/contract.md](references/contract.md) for the allowed token,
surface, component/state and asset fields, package limits, fallback semantics,
and validation/packing commands. Export the contract from the target checkout;
its parser and runtime are authoritative when documentation and code disagree.

[references/paint-owners.md](references/paint-owners.md) records current product
anatomy: which existing layer receives paint. Consult relevant rows when choosing
a target. DOM hooks and CSS classes in these notes are not new package fields.
If a required target does not exist, report the limitation rather than inventing
an id, selector, CSS override, or layout field.

A token-only skin, local-material skin, or shared-background skin can each be
valid. One declared mode is legal; complete every mode the user requests. Do not
drop light mode to conceal a defect when both light and dark were requested.
The format does not require a particular palette, an image on every component,
generated artwork, a continuous wallpaper, or the Aurora example's recipes.

## Choose a method, rather than treating an example as a rule

[references/authoring-template.md](references/authoring-template.md) is an
**optional reference-to-skin workflow** with alternative visual directions,
asset-generation suggestions, starter usage and small recipe examples. Adapt or
replace it to match the brief while staying inside the contract. Read only the
sections relevant to the chosen direction.

The helper's `init` copies an editable starter plus
[paint-plan.md](references/templates/paint-plan.md) and
[visual-review.md](references/templates/visual-review.md) worksheets. These are
optional authoring evidence, not importer requirements. Direct authoring without
`init`, those worksheets, or their exact filenames is supported. The
[Aurora Paper example](examples/aurora-paper/skin.json) demonstrates syntax;
its [analysis](examples/aurora-paper/reference-analysis.md) records its limits.

Preserve supplied asset fidelity unless the user authorizes a tradeoff. Use an
available image generator when matching raster material would improve the
result; do not claim generation if it did not run. Keep source/generated asset
provenance outside the import manifest.

## Validate the package and review the visual result separately

Use the production parser through `validate`, then `pack`, then validate the
written ZIP. The helper checks structural conformance, not visual quality. Its
`deliveryStatus: draft-unverified` cannot be upgraded by a successful import,
projection count, worksheet checkbox or generated mockup.

Use [references/visual-review.md](references/visual-review.md) to inspect actual
product screenshots, affected pages and states, readable content, source
fidelity, corner/edge composition and unchanged geometry. Apply its full-page
matrix to a whole-product skin; scope a partial skin to affected targets and
record exclusions. Every requested mode needs evidence. When native access is
missing, state exactly what remains unverified and deliver a draft.

Keep failures in the correct owner: package token/asset/target errors can be
fixed in the skin; a broken product paint plane, absent target or clipped
product geometry must be reported as a product issue. Do not patch application
code or change geometry under the guise of creating a skin.

Deliver the validated ZIP, editable sources and a concise report of scope,
provenance, commands, actual screenshots and outstanding checks. Keep analysis,
contract exports, worksheets and diagnostics outside the import ZIP. Developer
projection details belong in authoring evidence, not normal product skin cards.
