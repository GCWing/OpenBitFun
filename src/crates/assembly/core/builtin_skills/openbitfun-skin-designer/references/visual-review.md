# Visual acceptance: evidence, not import rules

Use this to review the delivered package in the product. It is independent of
[contract.md](contract.md): passing the parser does not pass this review, and a
visual preference does not create a new schema restriction. Design-method
suggestions are in the optional [authoring template](authoring-template.md).

## Set scope and capture conditions

Record the exact app build, package hash, modes, OS, viewport and DPR. Inspect
all requested modes; fallback does not prove a separately designed palette.
Use wide and compact windows and the actual normal/maximized/OS-fullscreen
states affected by the skin. Maximize is not fullscreen.

For a whole-product skin, inspect the full navigation/page matrix below. For a
partial skin, inspect affected owners and their adjacent surfaces, document
unaffected exclusions and test all views reached by shared/global tokens.
An asset-free color brief does not need imagery or a motif in every screenshot.
A reference-driven immersive brief does need evidence of source identity beyond
welcome where that coverage was requested. Do not drop a requested mode or page
because it exposes a defect.

Use static/local QA data without sending a model request for screenshots. Check
populated/configured/expanded content as well as empty states. Prefer isolated
QA profiles for mutations, and record whether the result is native rendering,
browser fixtures, a mockup or unverified. Never present a mockup as an import test.

## Geometry and paint composition

Compare unskinned and skinned bounds, radii, padding, margins, font metrics and
hit targets at the same window size. Also inspect visible pixels: equal CSS
radii do not prove that a square fill is absent or a curved silhouette survives.

- Inspect both scene corners through navigation collapse, expansion and resize;
  include retained hidden scenes and actual empty welcome. No stale underlay,
  unrelated wedge, second edge or independently cropped background strip.
- Inspect Select, Combobox and MultiSelect in field/pill, focus, open, disabled
  and nested-component states. Their material must follow the rounded owner;
  popup/input paint must not leak into square ancestors.
- Inspect ActionCard's outer surface separately from its inner button. Normal,
  hover, focus, selected and disabled states must keep material and feedback.
- Page/section headings and their action containers stay transparent; buttons
  retain their own paint. Dense copy, form groups, lists, notices and tables
  retain independent reading material. Do not mask missing local coverage with
  a page-wide wash or an opaque heading slab.
- Inspect adjacent content regions for doubled/overlapping plates and detached
  strips. Follow the product's existing owner; no new wrapper, radius, layout,
  padding, clipping rule or hook is authorable through the skin.

### Calendar continuity, clearance and interaction

Inspect an empty month and a populated month with repeated jobs, then select a
day, change month and return to today. Include wide/compact windows and every
requested mode. Confirm:

- Weekday labels and date grid read as one continuous region, with no seam,
  overlapping alpha bands or separate rounded strip between them.
- Calendar title and month-action container have no extra background plate;
  their labels/icons, Today button and hover/focus feedback remain readable.
- First/last date columns have visible clearance from the material's side edges.
  Compare all four sides, selected-day borders and keyboard focus rings; none
  should touch, clip against or bleed outside the reading plane. Verify that
  paint stays inside reserved scene space in compact windows.
- Date-cell positions, widths, row heights, selection, month navigation and
  hit areas retain product behavior. Dense entries and their overflow indicator
  remain inspectable; an empty calendar is insufficient evidence.

Clearance and the continuous plane are product responsibilities. If a correct
package still reveals a flush edge or broken plane, report the product defect;
do not encode `12px`, CSS class selectors or guessed padding fields in the pack.

## Whole-product page/state matrix

| View | Evidence to collect when in scope |
| --- | --- |
| Welcome / chrome | Fixed brand, Hi, window-control contrast, crop, both corners; expanded/collapsed/resized navigation in windowed/maximized/fullscreen states |
| Home | Metrics, device and catalog cards, empty/loading/error content; headings/actions transparent and local content readable |
| Task board | Populated/inactive tasks, calendar continuity and all-edge clearance, repeated jobs, selected-day detail and month/today actions |
| Agents / Assistants | Cards, filters, create/detail/configured forms and normal/hover/focus/disabled states |
| MiniApps | Installed/market/library lists, filters and detail controls; plugin documents keep their own rendering boundary |
| Skills / Discover Skills | Both lists, empty/error states, pagination, expanded groups, item actions and focus |
| Settings / external import | Long explanations, configured ACP/subagent editors, Worktree groups, collapsed/expanded custom settings; scroll top/middle/bottom |
| Appearance | Import, preview, cancel preview, activate; mode selection and stale-paint cleanup |
| Insights | Model/range controls, empty/history/populated report and state feedback |
| FlowChat | Existing transcript, prose, user bubble, code/table bodies and toolbars, composer/context, focused input and model picker |
| Editor / terminal | Actual text, caret/selection, line numbers, widgets, open menu and scrolling |
| Overlay | Real menu, tooltip and dialog/picker; independent readable material, focus, boundaries and stacking |

## Contrast, reference fidelity and runtime evidence

Measure text against its actual composed background: target 4.5:1 for normal
text and 3:1 for large text and meaningful control graphics/boundaries. Record
method, sampled pair, ratio and screenshot. Flat swatches do not establish
contrast over an image or changing animation frame. A glyph shadow cannot
replace a reading surface for dense text. Inspect primary/secondary/placeholder,
disabled, selected, hover and error/status semantics.

When imagery is in scope, record original/delivered dimensions, frames/duration,
CSS size and DPR. Inspect source detail at native size, not only a contact sheet;
separate source softness from added encoding/upscaling softness. Confirm assets
load, source-derived material is recognizable in the requested working views,
and low intrinsic alpha/crop/occlusion has not hidden it. Do not silently reduce
resolution/frame rate or erase the image with a blanket wash to pass contrast.

Projection reports describe current mappings, not visual quality. Mount the
intended targets/states before interpreting unresolved entries; remove/fix
unintended or unsupported declarations. Release development subscriptions after
review. Product skin cards do not need these debug paths/counters.

Use [templates/visual-review.md](templates/visual-review.md) if a worksheet helps.
Record pass/fail/unverified per affected case, or an explicit scope exclusion.
Repair failed cases and rerun related modes/transitions. If native access or
measurement is missing, preserve that limitation and deliver a draft. Structural
validation, a populated worksheet and a projection count are not visual proof.
