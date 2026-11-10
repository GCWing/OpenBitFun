# Optional product visual-review worksheet

Status: draft-unverified. Adapt or replace this worksheet; it is not an import
requirement. All rows start unverified. Fill actual evidence, never invented
screenshots, contrast values or checks. The helper does not perform this review.
Keep the worksheet outside the import ZIP.

Record app build, exact ZIP hash, OS, viewport/DPR, requested modes and validation
commands. For each affected row, record expected/actual result, screenshot,
transition and pass/fail/unverified. Light/dark columns are a starting example;
add high-contrast columns if requested, or state when a mode was not requested.
An exclusion needs an unaffected scope/reason; do not exclude a failed requested
mode/page. For a whole-product skin, review the complete navigation matrix.

| Check | Light | Dark | Expected result / evidence |
| --- | --- | --- | --- |
| Package conformance | unverified | unverified | Exact delivered ZIP passes production parser and authoring lint; not visual acceptance |
| Source fidelity, when imagery is in scope | unverified | unverified | Dimensions, frames/duration, DPR and native-size crop; no silent downscaling |
| Reference identity in requested working views | unverified | unverified | Actual source-derived material/scene visible beyond welcome; not required for a color-only brief |
| Hi / window controls | unverified | unverified | Normal/hover/pressed/focus readable; original shape, anchor and hit areas |
| Windowed / maximized / OS fullscreen | unverified | unverified | Record each real state; both scene corners, expanded/collapsed/resized navigation |
| Collapse/expand and navigation resize | unverified | unverified | No stale strip, wedge, bleed, double edge or independent crop |
| Welcome to working page and back | unverified | unverified | Intended shared/local image composition; working content readable |
| Field / pill Select, Combobox, MultiSelect | unverified | unverified | Closed/open/focus/disabled corners; material on rounded owner, no square ancestor |
| Default / embedded / panel SearchField | unverified | unverified | No duplicated input fill, rectangular focus shadow or portal paint mismatch |
| ActionCard outer surface and inner button | unverified | unverified | Rounded material and normal/hover/focus/selected feedback; no inner square fill |
| Tabs and close action | unverified | unverified | One expanding surface; selected/unselected, hover/focus, unchanged hit target |
| Home | unverified | unverified | Metrics/device/catalog cards and empty/loading/error states readable |
| Agents / Assistants | unverified | unverified | Cards, filters, create/detail/configured content and action states |
| MiniApps | unverified | unverified | Installed/market filters, list/detail controls; plugin document boundary retained |
| Skills / Discover Skills | unverified | unverified | Both lists, item actions, empty/error, pagination and hover/focus |
| Settings top/middle/bottom | unverified | unverified | Custom copy/lists/notices have local material; headers and action containers stay transparent |
| Configured / expanded settings | unverified | unverified | ACP modes/editor, Worktree headers/rows, More settings, Memory processing collapsed/expanded |
| Task board list and detail | unverified | unverified | Populated/inactive tasks, selected-day detail, date and month/today actions |
| Calendar continuous material | unverified | unverified | Weekday/date body is one plane; no separate action plate, seam, overlapping-alpha band or detached strip |
| Calendar all-edge clearance | unverified | unverified | First/last columns have visible side space; selected borders/focus rings do not touch or clip; bottom/top checked too |
| Calendar dense / compact cases | unverified | unverified | Repeated jobs, overflow indicator and selected day; no gutter overflow or geometry changes in narrow windows |
| Insights | unverified | unverified | Model/range controls, empty/history/populated report |
| FlowChat | unverified | unverified | Existing transcript, long prose, user bubble, code/table, composer/context and focused input |
| Editor / terminal, when affected | unverified | unverified | Actual text/caret/selection, line numbers/widgets, open menu and scrolling |
| Overlay | unverified | unverified | Real menu/dialog/picker/tooltip; independent material, focus and stacking |
| Before/after geometry and silhouette | unverified | unverified | Bounds, radii, padding/margin/font metrics/hit areas unchanged; visible curves survive |
| Composed contrast and semantic states | unverified | unverified | Actual imagery/frames, sampled pair/method/ratio; primary/danger, disabled, selected and focus distinct |
| Other affected targets | unverified | unverified | Add cases required by the brief or by shared/global tokens |

Use static/local QA data, not a model request just for screenshots. Confirm image
loading, owner, occlusion, crop and intrinsic alpha before increasing strength.
Do not add an image/recipe merely to fill a worksheet row or increase counts.

Classify each failure: incorrect token/asset/target in this package, unsupported
capability, or product paint/layout defect. Continuous reading planes, gutter
padding/clearance and focus clipping belong to the product, not invented skin
fields or CSS patches. Record the exact build when a product fix is required.

Repair affected cases and rerun related modes/transitions. If app access is
blocked, deliver a draft with outstanding checks. A checkbox, generated mockup,
projection count or successful pack command does not establish a visual pass.
