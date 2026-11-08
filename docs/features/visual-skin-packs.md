# Visual Skin Packs

Embedded field parts can declare `data-openbitfun-paint-layer="none"`: the parent
owns their surface, and part recipes must not paint a second rectangle or focus
shadow. The same resolver excludes these targets from projection diagnostics.
When inherited shell artwork is visible on the no-tab landing page, chrome shares
its image plane; icon outlines provide contrast without rectangular control bases.
Reading pages keep opaque chrome. Explicit surface profiles retain ownership.
An explicit `backgroundSource: "shell"` profile reveals the single shell image
instead of creating a second independently cropped backdrop. Its `baseOpacity`
(default 1) controls only that surface's material. On `workbench-content` this
also clears the structural toolbar/viewport chain; nested reading surfaces,
settings roots and overlays retain independent ownership. No layout, radius or
element opacity changes. A missing/disabled shell image keeps the opaque
fallback and reports the dependency as unsupported. Expanded shared navigation
extends the same base alpha behind the scene curves over the same shell pixels;
collapsed navigation reveals shell artwork. Neither changes the original radius.

Authoring preserves source resolution by default and records source/delivered
dimensions, animation timing and actual display scale. The archive byte limits
are transport/extraction bounds, not decoded-memory or visual-quality budgets.
An immersive skin needs recognizable source material outside welcome, not only
palette changes and generic symbolic ornaments. Inspect native-size sharpness,
reading contrast and launcher states alongside package validation.
Collapsed navigation chrome delegates its root paint to the scene rather than
reusing the expanded sidebar's material. Over landing artwork its glyph uses
the same outline contrast as caption controls; geometry and native hover remain.

FlowChat exposes the existing user-message `surface`, Markdown `tableSurface`
and `tableHeadingCell` as paint-only targets. The message's content box does not
own its rounded background. Code toolbar/table headings can carry motifs while
body text and syntax backgrounds remain quiet. These parts change no layout.

Component materials support bounded image size/position/repeat, image-only alpha
over an opaque base, and public token references for foreground, border and
shadow. State part paint merges over its base; `assetId: null` clears an image.
The element `opacity` field is rejected, without migration or alias. No part
paint changes dimensions, typography, radius, layout, markup or interaction.

Button/IconButton/TabGroup advertise their existing background paint layer;
materials reach that layer without inserting DOM or replacing pseudo-elements.
Other parts paint their own box. TabGroup routes border/shadow to its expanding
surface with `data-openbitfun-edge-layer="before"`, avoiding a second outline
around the label button when the close action appears. Button keeps its native
element border. Interaction selectors update paint directly in CSS; state events
refresh diagnostics without recompiling skin CSS or rewriting surface markers.
Only mode or paint-target ownership changes require recompilation. Text-only
streaming and unrelated class/style changes do not trigger skin refresh work.
Implicit roots and child-part interaction states
use a shared matching rule for CSS and projection diagnostics, bounded by nested
component ownership. Switch exposes its input/track/thumb anatomy and keeps
native checked/disabled behavior. Validated images use display-only Blob URLs,
emitted once per package through a private CSS variable family. This keeps large
PNG data out of CSS declarations. Active and preview resources survive failed
mutations; discarded resources are released after paint replacement, and disposal
removes owned paint before releasing URLs. Package files and stored image data
remain unchanged; temporary display URLs are never persisted or exported.

The create-visual-theme Skill requires a component/state material plan and actual
visual acceptance alongside package validation. Projected paths alone do not
establish participation or readability.

Visual Skin Packs are declarative visual overlays generated from a reference
image. They are imported from a single JSON file or a ZIP archive and are
applied by the Web UI's `VisualSkinRuntime`.

The importer accepts two package forms:

- **Canonical JSON** uses `manifest`, `modes`, `assets`, `components`, and
  `surfaces`. JSON assets must be embedded as base64 data URLs.
- **ZIP** may contain a canonical `skin.json` with declared package-relative
  image assets. The importer also accepts the multi-file entrypoint format
  (`format: openbitfun-visual-skin`), resolving its token/asset/slot/recipe files
  into canonical fields. New Skill output uses the canonical format directly
  to avoid authoring fields that the conversion does not project.

The runtime accepts the public token contract from
`@openbitfun/theme-openbitfun` and `@openbitfun/design-tokens`, named visual
slots, component recipes, interaction states, and surface profiles. It validates
identifiers, exact public token names (without aliases), asset MIME types, data URLs, package-relative paths,
archive size, and undeclared files before persisting a package. ZIP directory
metadata is checked before extraction (96 entries including directories,
16 MiB per entry, 416 MiB total); manifest/entrypoint reads additionally have a
512 KiB limit. Extraction uses a bounded streaming sink, cancellation, and CRC
validation. Actual output is bounded as well as declared sizes, and each asset
is extracted once. Packages cannot
provide CSS, selectors, JavaScript, network URLs, markup, product copy,
permissions, or business logic.

The importer consumes image assets, semantic/theme colors, component color
aliases and public color/shadow system tokens. Radius, spacing, typography
metrics, layout, control dimensions and motion tokens are rejected. A package
cannot ship executable font or stylesheet code.

Recipes are intentionally declarative. The importer projects the recipe id,
supported surface id, `fill`/`base` layers into `baseToken`, resolved
`slot`/`backdrop` layers with safe fit, focal position, and opacity,
`scrim`/`tint` layers with public token and opacity, `shape`/`content` radius
plus edge ownership, component tokens, and bounded interaction states. The
runtime produces a projection report with projected, inactive, unresolved, and
unsupported entries. It never turns a recipe into arbitrary CSS or layout
rules.

Surface artwork is composited in product-owned layers. A surface `baseToken`
sets the opaque fallback fill, a background asset is rendered as a backdrop,
and optional `scrimToken` and `scrimOpacity` control its contrast layer, and
the existing surface content remains opaque. `backgroundPosition` carries the
asset focal placement; `backgroundOpacity` controls the image layer. If a
scrim token is supplied without an opacity, its opacity is `0`; tinting is
explicit. Generated packages should provide an explicit value after
checking the composed contrast. Paint planes inherit the existing product
radius; skins cannot override radius or edge geometry.

Shared `surfaces` are defaults. Each `modes.<mode>.surfaces` list can replace
complete profiles by surface id, after fallback-base selection and before the
requested mode override. Missing fields in a replacement are cleared. Runtime
painting, projection diagnostics, and Skill composition reports share this
resolver, including high contrast. This permits distinct light/dark artwork,
crop, image strength, local tokens and scrims without removing either mode.

The fixed surface contract currently includes `shell`, `workbench`,
`workbench-content`, `navigation`, `chat`, `editor`, `terminal`, and
`empty-state`. Product components opt into this contract with
`data-openbitfun-surface` and `data-openbitfun-skin-slot` attributes. Skin
recipes can therefore change the visual treatment of the existing component
tree while the product owns structure and interaction behavior.
All component shapes, sizes, spacing, typography metrics, and positions remain product-owned. Skin packages expose only paint tokens (colors and shadows), backgrounds and decorations; geometry tokens, surface radius/edge overrides, and layout fields are rejected. The welcome brand keeps its product-owned centered position. Component recipes
control paint only, not layout, coordinates, hiding, or repositioning the brand.
Settings retain local reading material over artwork: subtle FieldGroups and
notices default to the panel token, and custom explanatory blocks can expose
the existing `config-page.sectionBody` paint owner. Flush layout groups delegate
paint and stay clear. This protects dense copy without dimming the whole page
or painting a square ancestor behind an existing rounded table. Custom scene
regions mark `data-openbitfun-reading-surface="self"` on an existing padded card
or `"before"` on an unpadded content block. The latter uses a noninteractive
paint plane in existing spacing, with no layout or control geometry changes.
Configured ACP cards, Worktree groups, calendars, skill items/pagination and
Insights use this local material in both modes. Home metrics and catalog cards,
Agent/Assistant cards, and MiniApp filters/list surfaces also retain local material.
Their structural scene canvases reveal materialized workbench artwork; without
artwork they retain the original scene base. Combobox/MultiSelect control planes
follow the visible trigger radius, including pill variants. ActionCard paint belongs
to its rounded outer surface, not the inner button that receives arbitrary props.
Exposed gallery/home headings use a small semantic glyph halo over artwork,
without a card or changes to typography metrics. Page and section titles, including their action containers, stay transparent
without an extra card or forced panel foreground. Buttons keep their own paint
and interaction states. Disclosure controls retain local material whether
collapsed or expanded. Calendar weekday labels and dates share one continuous
reading plane extended into the reserved scene gutter so cells and focus rings
have room at both edges without moving the grid; its title and month actions
stay transparent instead of acquiring separate overlapping plates. No observer or per-hover
computation is involved; clear scene gaps still reveal the source artwork.
For a continuous full-window backdrop, assign artwork to `shell` once and omit
unneeded child profiles. Only the active empty welcome reveals the inherited backdrop automatically.
Undeclared working surfaces keep their semantic base; explicit local artwork
can opt into a composed surface without clearing sibling readers or overlays. Avoid repeating
the same image on navigation and scene surfaces with separate crops.
Navigation includes its history row; workbench-content is the actual rounded
scene frame including its top toolbar. Artwork and scrims live in a reserved
React child paint plane, which inherits that frame's radius and clips only
paint. Existing pseudo-elements, control hit bounds, overflow and positioning
are retained. The shared corner underlay uses the selected navigation base and
its local tokens. It belongs to the scene area's actual edge, following live
navigation resize and collapse instead of estimating a sibling's width. The
unskinned/native glass sheet keeps its original owner. Top controls use chrome
material unless the frame explicitly owns artwork. Structural header/viewport fill can be transparent when the frame owns
explicit visible artwork. Ancestor shell artwork alone never clears a working
page: undeclared content surfaces keep semantic reading bases. Only the actual
empty landing viewport may reveal inherited shell artwork, so a retained hidden
welcome cannot clear a settings page. Configured child surfaces reset their own
layers. Component cards, menus and dialogs retain their own fills.
Shared settings-page paint uses `config-page.root` on the actual scrolling page,
alongside each page's specific Appearance identity. This target remains present
when a caller supplies a specific component id; its paint does not clear cards
or change page geometry.
The chat canvas owns its artwork; the input wrapper does not share the chat
surface marker. Each surface isolates its backdrop and scrim below content
without changing children's position or z-index. A materialized nonzero-opacity
editor backdrop makes only the known code-editor paint chain transparent;
menus, headers, selections, widgets, and other panel types retain their normal
backgrounds. Removing or previewing away from that artwork restores default
paint. Without local editor artwork the known Monaco paint chain inherits its
own reading surface, preventing a disconnected built-in white rectangle.
`fill` sizing maps to CSS `100% 100%` for both surfaces and part assets.
The transcript wrapper also becomes transparent when its chat canvas has
artwork. Editor backdrop blur on the known panel wrapper is disabled in that
same opt-in scope so authored patterns remain sharp. Component recipes can
target existing `data-openbitfun-scene` ids as well as standard/product component
ids, using the same owned-part resolver. Product part names retain their exact
spelling, including `contextBar` and `pageHeader`; other id namespaces remain
lower-case. Native review of these paths uses real product windows and renderer
content; static style boards are not visual acceptance evidence.
Global slot overrides are limited to the seven corresponding `*-background`
slots plus `empty-state` (without a background suffix). Component recipes may address any product-owned component and its
bounded `data-openbitfun-state` vocabulary (including product states such as
`active`, `loading`, `expanded`, and `dragging`) through tokens and named
decorative parts.

For a usable skin, provide distinct semantic roles for the canvas, scene,
panel, raised surface, chrome, border, primary/muted content, text over image,
accent, focus/selection, and status states. A single dominant sampled color
does not provide enough tonal separation for the application shell. Validate
the composited result at navigation, empty state, chat, editor, and terminal
surfaces in wide and compact viewports; inspect shared edges for 1px gaps,
double borders, clipped corners, and image bleed.

Skin selection is local to the current Web UI host. The active package is
recompiled when the design system switches light/dark mode or high contrast.
Installed packages and the active selection are stored in IndexedDB. Storage
unavailability produces an explicit error. Each persisted record is validated
independently. Invalid records remain stored and appear in settings with their
actual storage key, validation error, and an explicit removal action; they do
not prevent valid packages from loading or activating. No record is repaired
or silently discarded. A missing or stale selection is cleared
without removing any package. Preview applies the same projection temporarily and never
writes the selection. Activation waits for the selection transaction to commit
before replacing the visible skin. A failed selection write preserves the
previous display, including an in-progress preview, and reports an actionable
error. Package deletion and clearing a selection that points to that package
commit in one IndexedDB transaction. A rejected deletion preserves the package,
selection, display, and catalog. Cancelling a preview or deleting its package
restores the active display without rewriting the persisted selection. Deleting
the active package during a different preview keeps that preview visible.

Skin cards show package information and preview, activation and removal actions.
They do not display projection counters, manifest paths or developer diagnostics,
and settings do not subscribe to live projection updates. Operation failures and
invalid stored records remain visible, with explicit removal for invalid records.
The developer report remains available through `skinRuntime.getSnapshot().projection`;
it names the current mode and actual fallback base. Authoring/debug tooling can
explicitly call `watchProjection` for live interaction-state reports and must
release the returned subscription when finished. Mode/target changes still
refresh the report without a watcher.
Declarations from inactive modes or
replaced by high-contrast overrides are `inactive`. `projected` means a supported
declaration maps to a currently mounted target (and an active state, when
applicable). This is not proof that a token is consumed or that its final visual
effect passes review. `unresolved` means the target or state is not present;
`unsupported` means the declaration is outside the current contract. The report
refreshes for mode and DOM ownership changes; live watchers additionally track
ARIA/native state, focus, and pointer changes. Inactive and unresolved entries
describe scope and state rather than failed imports or activation errors.

Component decorations use the same ownership resolver for CSS and diagnostics.
A named part may be the component root or an owned descendant. A nested
component or surface starts a new ownership boundary, so an ancestor's
interaction state cannot decorate a nested instance's same-named part.

The existing Appearance runtime remains responsible for renderer adapters
(Monaco, xterm, Mermaid, widgets, and canvas); the skin overlay only supplies
the shared semantic visual layer and fixed decorative projections.

For authoring instructions, evidence capture, accessibility checks, asset
provenance, and the generated example, see
`src/crates/assembly/core/builtin_skills/create-visual-theme/SKILL.md`.

The Skill includes `scripts/visual-skin.mjs` with `contract`, `init`, `validate`,
and `pack` commands. It loads the target checkout's production parser and public
contract using the installed frontend tooling; it does not maintain a parallel
token catalog or persist/activate a skin. Authoring lint rejects unsupported or
ignored fields, unknown global-slot declarations, duplicate targets, and
settings with missing dependencies. ZIP creation includes only the canonical
manifest and declared path assets, rejects assets escaping the directory, and
validates before writing a new output file. Analysis, screenshots, and reports
remain outside the import ZIP. Structural validation does not prove CSS
consumption, product projection, or visual quality; those require the in-app
diagnostics and composed screenshot/contrast review described in the Skill.
The authoring report explicitly labels output `draft-unverified` and lists
component targets and nominal image contributions after backdrop/scrim opacity
by declared mode. Source asset alpha, cropping, CSS consumption, inherited
overrides and occlusion are outside that estimate. It is a review aid, not an
automatic aesthetic or accessibility acceptance threshold. Reference-driven
delivery must demonstrate recognizable motifs beyond the welcome backdrop
and verify real product boundaries before it is described as visually complete.

The rounded workbench-content frame exposes `empty` when no scene tab is active.
State token recipes can give the landing page its own material and contrast
without splitting the working top bar from its body. Shared navigation extends
its base alpha behind both scene curves, preserving the original visible panel
boundary; collapsed navigation reveals the shell. Settings group paint uses `config-page.sectionBody` on the actual FieldGroup
owner (the library retains its `field-group` identity). Keep group material
on the containing section instead of painting every heading row independently.

For clear-source working pages, transparent frame/chat profiles preserve the
source artwork while native fields, code and tables keep their reading surfaces.
`textShadowToken` references a public shadow token for glyph-only `text-shadow`;
its value must be text-shadow-compatible, without box spread or inset. It adds
no background plate, layout, opacity, filter, observer or image copy. Markdown
headings inherit their document root foreground, preserving the default theme
while allowing a document's image-contrast foreground to reach its headings.
Do not equate unchanged DOM boxes with unchanged visual silhouettes: a filled
Markdown root can still look like a new panel. Validate contrast and original
source clarity in real paragraphs, headings and settings groups in each mode.
