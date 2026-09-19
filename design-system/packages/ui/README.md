# @openbitfun/ui

Theme-independent React primitives and components.

```tsx
import "@openbitfun/theme-openbitfun/default.css";
import "@openbitfun/ui/styles.css";
import { Button, ThemeRoot } from "@openbitfun/ui";

export function Example() {
  return (
    <ThemeRoot colorScheme="light" density="comfortable">
      <Button>Continue</Button>
    </ThemeRoot>
  );
}
```

The package owns component anatomy, behavior, accessibility, and stable variants. It does not own theme selection persistence, product state, routes, locale resources, or platform APIs.

Floating dialog/sheet overlays, menu popovers, select/combobox popups and tooltips declare
`data-openbitfun-native-webview-occlusion` on their rendered floating surface.
Native hosts use its visible bounds to temporarily hide overlapping child views;
the components do not call platform APIs. Custom product popovers should declare
the same marker on the floating element, including while its exit animation runs.

## Voice calls

`VoiceCallPanel` owns the complete compact call surface: navigation, particle
logo, scrolling transcripts and mute/settings/end controls. Pass localized
`title`, `labels`, transcript strings, optional `status`, and callbacks from
the host. Returning to chat, closing the window and ending a call are separate
callbacks so the package never decides session or window lifetime.

Typography follows the shared `type.heading.panel` role for the title (18px,
semibold) and `type.body.lg` for transcripts and status text (15px, regular,
1.6 line height). Both use the canonical interface font stacks and follow user
font-size preferences. Compact-height layouts keep the same typography roles.
User bubbles apply `type.modifier.leading.tight` for 18px leading, with 12px
padding on all sides and a 12px corner radius. They fit their content and wrap
within the conversation width; a single line is 42px high at the default size.

`VoiceCallTranscript` exposes its `entries` part for host-owned reading insets
and `data-scrolled` when records have moved below their starting position. Hosts
can layer compact controls above that viewport without creating another scroller.
Each entry may supply `activity` beneath its message; the host owns its real
processing state, localized accessible label, and completion lifecycle.
Its `presentation="chat"` variant uses FlowChat's `type.flow.control` text size
and weight, `type.flow.body` font stack and leading, `color.content.primary`
text, and `color.action.quiet.hover` user-bubble fill. `compact` controls spacing
independently. The default `presentation="voice"` retains the call typography
and inverse colors; hosts can switch presentation on the existing viewport.

`VoiceParticleLogo` is also exported independently. Its `readAudio` callback
reads `{ user, assistant, assistantSpeaking }` once per animation frame. The
two spectra are FFT byte bins from analysers configured with `fftSize = 256`;
pass `null` for muted or unavailable audio. `assistantSpeaking` describes the
audible playback clock, including queued audio that outlives a provider's
completion event. Omit the callback for the calm resting motion.

The supplied Voice-Particles-Demo contour, sampling, force coefficients,
envelopes, density and brightness profiles are preserved in a fixed simulation
space; resizing changes only its projection. The host supplies real capture and
playback, and keeps permission, network, transcription and audio cleanup outside
the component. The canvas pauses offscreen, when inactive or hidden, and renders
a still logo for reduced motion. Both components are registered in Design Lab;
its presentation specimens do not capture or simulate speech.

The panel uses the semantic on-light/on-dark endpoints: 80% dark background,
30% light user bubble, full light text and 20% light circular controls. Render
it on a transparent host shell to avoid applying the background opacity twice.
The host allocates its dimensions; the product uses the existing 480 × 680
compact-window contract. Build and source tests do not prove visual fidelity.

## Buttons

`labelBehavior="overflow"` is the default and retains the shared OverflowText
behavior. Use `labelBehavior="static"` for actions whose text must keep its
existing wrapping or inline composition without adding clipping, a marquee,
or an automatic overflow tooltip. Static labels inherit the button's whitespace
and line height; button variants, sizes, loading, and disabled behavior stay the
same. An explicitly composed OverflowText child retains its own behavior.
The public `data-openbitfun-part` slots are `root`, `content`, `label`,
`leading-icon`, `trailing-icon`, and `progress`; use them for scoped product
layout instead of private CSS module classes.

Choose variants by action role: use `primary` for the main save, submit, create,
or confirm action, and `fill` for cancel, dismiss, or discard alongside it.
Keep `outline` for ordinary toolbar utilities and secondary choices. A neutral
`fill` button is a low-emphasis surface, not an alias for `primary`. Preserve
`tone="danger"` for destructive actions. Disabled and loading states belong to
the same variant; do not switch a primary action to outline when it is disabled.

Button outline and text variants have transparent resting surfaces. Fill and
primary state colors come from the theme's `component.button.*` contract, with
variant-specific disabled content. The secondary variant keeps its opaque
tertiary surface. All variants retain the existing xs/sm/md/lg dimensions;
text buttons keep those hit targets while omitting the visible pill background
and radius. Use native hover, pressed, focus, disabled, and loading behavior in
addition to Design Lab's state specimens.

Hover and press feedback keeps controls at their resting size on desktop and
mobile. Use semantic surface, border, content, shadow, and opacity states;
do not add press scaling in components or host-wide semantic selectors.
Explicit content zoom, loading indicators, and enter/exit motion remain owned
by the component that needs them.

## Native scrollbars

`styles.css` owns scrollbar presentation inside `ThemeRoot` (or
`data-openbitfun-design-system-root`) and standalone `ScrollArea` viewports.
Native file trees, virtualized transcripts, navigation, menus, and dialogs use
the same policy without wrappers, scroll listeners, or timers.

On mouse/trackpad surfaces, the thumb appears while its own viewport is hovered
or contains visible keyboard focus. Leaving the viewport hides it; scrolling
from streaming output does not reveal an unattended panel. Touch surfaces retain
visible native thumbs, and forced colors retains system accessibility colors.
Tracks stay transparent. Only color changes, so hover never changes viewport
width, overflow, or scrollbar gutters.

`ScrollArea` keeps `scrollbarVisibility="auto"` as the default. `always` keeps
the thumb visible and reserves a scrolling track; `hidden` deliberately hides
the native scrollbar while preserving scrolling. `Menu`, `Listbox`, and
`NavigationPanelBody` forward the same contract. Product styles own layout and
`scrollbar-gutter`, not local scrollbar colors or show/hide handlers. Monaco
and terminal renderers keep their own scrollbar APIs.

## Text overflow


Use `OverflowText` for single-line, non-editable labels instead of local
`text-overflow: ellipsis` rules or shortening the underlying string. Plain text
defaults to **fade-out truncation with an interaction marquee**: a background-independent
gradient mask at the inline end, followed by scrolling on hover or keyboard focus.
Both effects apply only when the text actually overflows. Short labels remain untouched.
Single-line text uses a vertically centered inner box with the font's natural leading
so tight control line heights do not clip descenders. The outer box keeps at least
the owner's line height (`1lh`), without an extra inline baseline strut shifting
the text relative to adjacent icons. This applies to plain-text
fade and marquee labels; multiline clamps and rich composition retain their layout.
Let text slots size naturally in the block direction instead of forcing a text-height
box or adding outer pixel padding to compensate for clipped glyphs.
Overflowing labels also open a wrapping, selectable tooltip on hover or keyboard
focus, including when motion is reduced. The tooltip uses the owning
`data-overflow-trigger` control and groups its clipped text slots into one popup.
Standard button, menu, navigation, card, selection, and disclosure text slots
already use this primitive; consumers should not wrap those slots a second time.

```tsx
import { OverflowText } from "@openbitfun/ui";

// The surrounding layout owns the available width.
<OverflowText>{description}</OverflowText>

// Mark the owning control so its whole hit target and keyboard focus reveal text.
<button data-overflow-trigger style={{ maxInlineSize: 220 }}>
  <OverflowText behavior="marquee">{workspaceName}</OverflowText>
</button>
```

String, number, and plain-text array children use marquee automatically.
Use `behavior="fade"` for a deliberate static label, and `behavior="marquee"`
for text-only rich markup such as search highlights. Standard interactive controls
already own the hover/focus trigger. Put
`data-overflow-trigger` on one control or row, never the entire list. Virtual
selection may use `marqueeActive` on the label or `data-overflow-active="true"`
on its owning trigger, without adding another tab stop. `ListboxOption` forwards
its virtual active state through this contract. Selected
tabs do not animate automatically. Motion respects `prefers-reduced-motion`;
reduced-motion users keep the static fade. Text and movement follow RTL direction.

Use `overflowStyle="ellipsis"` when a single-line slot requires a visible ellipsis
instead of a resting fade. It works with static `behavior="fade"` labels and with
`behavior="marquee"`, which reveals the full text on interaction and returns to
the ellipsis afterward. Reduced motion keeps the ellipsis. Multiline clamps retain
their existing behavior. Set `marqueeTrigger="interaction"` to ignore virtual
active state on both the label and its owner; the default
`"interaction-or-active"` preserves existing listbox behavior. This also prevents
virtual activation from opening the label's tooltip; actual hover/focus still works.

Rich children default to fade to preserve the label's existing inline composition.
Composite containers keep their icons/actions fixed and give each text slot its
own `OverflowText`. Marquee measures and
translates one inline text span; keep icons, badges, and action buttons outside
it. Complete text stays in the accessibility tree. Plain-text arrays and rich
labels use their complete rendered text in the tooltip. A supplied `title`
overrides that text; `title=""` opts out when a surrounding native title owns the
content. An explicit enclosing `Tooltip` suppresses automatic nested tooltips.
Do not use marquee as the sole way to access information on touch surfaces.

Multi-line descriptions should normally wrap. Editable fields, source code,
structured paths that need to preserve their suffix, and native controls keep
their appropriate text treatment instead of receiving a blanket fade rule.
Mobile sheet/page titles and row descriptions wrap for touch access. Tooltips
also wrap: a full-text fallback must not truncate its own content.

For a compact multiline preview, use `<OverflowText as="p" lines={2}>` (or `div`
to preserve the existing semantics). It measures vertical clipping as well as
horizontal overflow and exposes the same full-text tooltip. Keep existing
click-to-open details or expansion controls available on touch surfaces.

The Web UI uses this contract in shell/navigation and search, workspace/session
lists, model and context pickers, file/Git lists, settings, tool-card summaries,
usage reports, and the Canvas SDK's truncating text/file labels. Remaining local
ellipsis rules are intentional source-code excerpts, contenteditable reference
chips/placeholders, and multiline message previews. Diagnostic/payload size caps
and persisted Appearance `textOverflow` values are data contracts, not layout rules.

## Text replacement motion

`RollingText` provides **vertical slide replacement** (also called rolling text):
the old line moves up and out while the new line enters from below. The line
positions and measured width share `motion.duration.contentSwap` (320ms) and
`motion.easing.smooth`. Initial render is static; the current accessible text
updates immediately, without a live region. The outgoing visual copy is hidden
from assistive technology.

```tsx
import { RollingText, TabGroup } from "@openbitfun/ui";

<RollingText transitionKey={record.id}>{record.title}</RollingText>

// TabGroup already owns its text slot; pass an identity instead of wrapping it.
<TabGroup
  aria-label="Views"
  items={[{ value: slotId, label: record.title, labelTransitionKey: record.id }]}
/>
```

Keep `transitionKey` stable for edits to the same resource. Without an explicit
key, changing the text triggers replacement. Plain strings and numbers are
supported; interactive elements, icons, and actions stay outside the rolling
line. The new title's natural width is measured within the existing layout
constraints before paint, then animated from the displayed width. No text clone
or frame-by-frame React measurement drives that animation. `OverflowText` still
owns truncation and the full-text fallback; its marquee resumes after replacement
instead of moving on two axes at once.

A running transition retains one outgoing snapshot and adopts the latest
incoming value, retargeting from the actual displayed positions and width.
There is no animation queue. Returning to the outgoing value reverses the roll.
`prefers-reduced-motion` disables replacement and cancels an in-flight roll when
the preference changes. Native animation completion owns cleanup, including
interruption and unmount; there is no timer duplicating the token duration.
Hosts without Web Animations render the current text immediately.

The **RollingText** Design Lab entry includes manual standalone and TabGroup
examples for repeated replacement and long labels.

`ActionItem` and its `NavigationPanelItem` composition also accept
`labelBehavior="static"` to preserve wrapping labels without an implicit overflow
tooltip or marquee. Their default remains `"overflow"`. The public `label` part
retains its typography, and the static label inherits whitespace from its owner.
`NavigationPanelItem.className` styles the outer row; native button attributes and
the ref reach its `trigger` part. Keep row layout separate from trigger styling.

`TabGroupItem.tabProps` applies `className`, `style`, `title`, `aria-label`,
`aria-describedby`, and `data-*` attributes directly to the native tab button.
Use product-namespaced data attributes for product appearance identity. The
component retains its own part marker, IDs, panel association, disabled state,
selection, focus, and event handling. Keep IDs and panel IDs in the item fields.

`TabGroup.renderItem(item, node, index)` can wrap the supplied standard item in
a tooltip, context-menu owner, or drag target. Keep `node` intact so TabGroup
continues to own selection, keyboard navigation, label overflow, and end-action
anatomy. Product wrappers own document states and layout, without replacing the
tab's control styles or creating another tablist.

## Mobile controls

Touch-first controls use the isolated mobile entry so compact and foldable
surfaces do not inherit desktop component geometry or ship desktop component
styles:

```tsx
import "@openbitfun/ui/mobile.css";
import {
  MobileActionSheet,
  MobileBadge,
  MobileBanner,
  MobileButton,
  MobileCard,
  MobileChoiceSheet,
  MobileConfirmSheet,
  MobileComposer,
  MobileDisclosure,
  MobileFileButton,
  MobileFloatingActions,
  MobileIconButton,
  MobileLink,
  MobileListRow,
  MobileMessage,
  MobilePageHeader,
  MobileScrim,
  MobileSection,
  MobileSegmentedControl,
  MobileSheet,
  MobileStatus,
  MobileTextField,
  MobileTextarea,
} from "@openbitfun/ui/mobile";
```

These components own mobile touch targets, pressed/focus/disabled states,
surface elevation, responsive inline sizing, composer geometry, transparent
floating action layout, and sheet accessibility. Product state, localized copy,
routing, and device or session operations stay in the consuming application.

`Checkbox appearance="native"` uses the visible browser checkbox, retaining its
native focus, disabled, checked, indeterminate, and form semantics. The default
`custom` presentation remains unchanged. Both presentations share sm/md/lg
sizing and the same label and description slots; native colors belong to the
browser, with optional consumer `accent-color` styling.

`Alert` preserves an explicit `role` and `aria-live`. An explicit `status` is
polite and an explicit `alert` is assertive unless `aria-live` overrides it.
Omitting both retains the existing default: role alert, polite announcements
except for error tone. Use `showIcon={false}` for text-only notices.

`Disclosure` is the shared expandable-content primitive. It owns controlled or
uncontrolled open state, trigger/region accessibility wiring, focus exclusion
while collapsed, reduced-motion behavior, and independent header actions.
Product copy and the revealed content remain consumer-owned.

Use `Disclosure presentation="native"` when the browser must own the existing
`details`/`summary` behavior. This mode renders a real details element, a direct
summary child, and the supplied content without extra wrappers. It accepts native
`open`, `name`, and `onToggle` attributes, and its ref points to that details
element. Browser focus, marker, wrapping, and content lifetime are preserved;
custom-mode `defaultOpen`, `onOpenChange`, `disabled`, and header slots do not
apply. Omitting `presentation` retains the custom disclosure contract above.

Sized icon slots in buttons, tabs, menu items and fields own their glyph geometry.
Pass catalog `Icon` nodes through `leadingIcon`, `trailingIcon`, `icon` or the
matching component slot, just as for SVG icons. These slots constrain catalog
icons to the component's size; a standalone `Icon` retains its explicit size
(24px by default). They also normalize a direct Lucide glyph that still has
Lucide's default 2px stroke to the shared 1.6 line weight and inherit the slot's
color. Explicit non-default strokes and non-Lucid SVG artwork remain unchanged.
Do not shrink the catalog globally to correct a slot mismatch.

`IconButton` defaults to `quiet`: its resting surface is transparent, hover and
pressed states use shared action feedback, and keyboard focus keeps a visible
focus ring. Use it for toolbar, dialog, and row utilities. `fill` and `primary`
keep an opaque backing surface for persistent emphasis. Disabled quiet actions
remain transparent and do not show hover or pressed feedback.

Use `size="xs"` for 22px square controls with 14px glyphs and a 4px radius.
`size="standard" shape="circle" variant="outline"` provides the 30px outlined
circle with a 16px glyph. Quiet and outline controls use the shared neutral
hover surface for both hover and pressed states; outline keeps its border when
disabled. Existing sm/md/lg sizes and the default sm size remain available.

General-purpose icons use **Lucide**. Named icons and explicit `glyph` icons
share a 1.6 line weight, semantic sizing, theme color and accessibility behavior.
Only `minimal`, `standard`, `ultimate`, `creative` and `git` retain reviewed
SVG masks. Product logos and mascots are separate brand artwork. The device
overview retains its original device/server SVGs and MacBook image in the Web UI.

Use a semantic `name` when available, or import the required Lucide glyph:

```tsx
import { Icon } from "@openbitfun/ui";
import { Network } from "lucide-react";

<Icon name="search" size="sm" />
<Icon glyph={Network} size="sm" />
```

Do not set `strokeWidth` at product call sites. Button, menu, tab and navigation
slots own final geometry and opacity; standalone named icons retain the public
`--openbitfun-opacity-icon-artwork` treatment. Brand assets retain their original
geometry, and fixture fingerprints protect the five preserved masks.

Use `canonicalIconNames` for galleries and pickers. Existing names remain
compatible: `download` aliases `arrow-down`, `circle` aliases `unselected`,
and legacy `turn` renders a Lucide circle. Use `NumberBadge` for numbered
markers; it owns a 24px filled surface and 11px regular text, growing horizontally
for longer values. `ToolbarBadge` delegates to the same anatomy.

Use `Icon name="session"` in new consumers. `SessionIcon` keeps its SVG props
and ref interface, using the same Lucide MessageCircle glyph.

## Advanced selection and menus

Use `Select` for simple options; its hidden native control preserves form
participation. `Combobox` adds searchable single
selection, grouped options, explicit custom-value creation and async loading
states. `MultiSelect` owns multiple selection, removable tags and select-all.
Controlled values are authoritative; option discovery remains host-owned.
Wrap the product once in `DesignSystemProvider` to supply translated messages,
the portal host, theme facts and the shared overlay layer stack.
The Web UI's legacy Select implementation is retired. Like retired Button and
Switch overrides, legacy `components.select` Appearance rules are ignored at
the existing read-only migration boundary; original packages are not rewritten.
Selection visuals now come from the public field/menu semantic tokens.
SearchField sizes its decorative wrapper through Input's icon slot, so default
catalog icons and native SVGs occupy the same region. Shortcut hints and clear
actions can coexist; disabled and read-only fields disable the clear action.
Use `trailing` for inline text or indicators and `trailingAction` for terminal
`IconButton size="xs" shape="square"` controls (including tooltip-wrapped controls). Actions
follow the shortcut hint, with the built-in clear action last. Standalone and
panel fields inset terminal actions equally from the inline-end and block
layout edges using `(input row height - action size) / 2`. The search outline
is centered on those edges and does not participate in layout; its inner edge
reduces each visible clearance equally by half the stroke width. Text-only trailing content retains
the ordinary trailing input padding; embedded fields retain container-owned geometry.
Search rows use `control.searchField.height.sm/md/lg`; compact `sm` is 30px,
while other sizes and densities alias the generic control heights. Leading
padding uses `space.component.inline` and icon-to-text spacing uses `space.1`.
An absolute-positioned search host must reserve that same search-row height.
The built-in clear action uses the shared square xs quiet-button hover feedback.

Choose `size` explicitly when composing form rows: selectors default to `md`,
while `Input` defaults to `sm`. Except for SearchField's dedicated row contract,
the shared `control.height.sm/md/lg` tokens and
active density own the actual heights; consumers must not replace them with
page-level heights or padding overrides. Picker bodies stay single-line and
token-sized, with labels and validation messages outside that height. Select
keeps its in-flow anchor mounted when the unified popup covers it, so opening
does not change the surrounding layout.

`Combobox` and `MultiSelect` use the same joined-surface pattern: the portalled
search header covers the closed trigger, with a divider and scrollable options
inside one border and shadow. Flipping above the field keeps the search header
beside the anchor. Labels, validation, and the field id follow the active input;
Escape or selection restores the trigger, and Tab continues from its position
in the form. Search, typed values, and multiple selection remain component-owned.
`SearchField variant="embedded"` removes its standalone pill surface for these
compositions; its container must supply padding, height, and visible focus
treatment. Standalone SearchField pills use a subtle neutral border, increasing
to the default neutral border on hover and focus while preserving validation
and forced-color states. This search-specific treatment does not change Input.

`SearchField variant="panel"` provides a joined frosted surface with a rounded
input row and an optional `footer` slot for result status and actions. It reuses
the same input node when switching from the default pill, preserves input-row
height, and provides a divider, metadata typography, and a single focus outline.
The whole panel combines the raised semantic surface at 80% opacity with the
medium backdrop blur and overlay shadow; its input and footer remain transparent.
The panel uses the same quiet focus border, with an opaque fallback for
unsupported blur, reduced transparency, or high contrast. Callers own the query, localized
counts, navigation callbacks, and disabled action states; use `IconButton` for
the actions. The panel stays in normal flow by default. A toolbar that needs
downward expansion without reflow should reserve the input height and position
the SearchField over that anchor.

`FieldGroup fieldSurface="ambient"` keeps text and picker field borders while
letting their shells reuse the grouped surface. The default field surface stays
theme-owned, and portalled menus remain on the opaque panel surface.

`Menu` remains composable inline anatomy. `MenuPopover` composes it into a
controlled anchored or coordinate popup. Pass `items`, `open`, `onClose` and
either `anchorRef` or `position`. Entries can include `submenu`, `shortcut`,
`disabled`, `checked`/`role`, and `onSelect`. Activation closes the tree and
restores focus before dispatching `onSelect`; the host owns asynchronous work
and error handling. The popup flips and clamps to the viewport, keeps keyboard
navigation in the active menu, and supports safe pointer travel to either side.

Portals resolve through `DesignSystemProvider.portalHost`, then fall back to one
document-owned overlay host above application content. Stable `parts` wrappers preserve host data hooks;
they must forward all props and refs and retain public component ownership.
`useSubmenuIntent` is available for product popovers that need the same pointer
corridor behavior.

Custom composed menus reuse `useDismissibleLayer` and the public `usePresence`
hook. Keep the positioned/measured layer separate from its animated surface,
retain geometry until presence unmounts it, and make exiting content inert.
Presence cancels a pending exit when reopened and honors reduced motion.
The host should opt a presence-owned surface out of its fallback animations;
outside-pointer dismissal leaves the clicked control's focus alone, while
Escape and menu actions restore the trigger before handing off to another UI.

### Overlay ownership and ordering

`Portal` (or its expression form `createOverlayPortal`) registers each presented
surface with one coordinator per document. All providers in that document share
the same order. New openings receive a later rank; content/progress updates and
StrictMode effect replay retain their rank. Reopening a retained surface brings
it forward. Do not use category z-index values to rank menus, dialogs or notices.

Nested portals inherit ownership. Sibling portals and coordinate menus pass
`ownerRef` for their source element, including menus rendered by a global
renderer. Child menus remain above their owner, belong to its modal focus domain,
and become hidden when that owner closes. A modal may have owned child portals;
unrelated background surfaces remain inert through its exit transition.

Use `open={open}` for retained exits and unmount when the exit completes.
Custom modal portals additionally pass `modal`, `surfaceRef`, and `onDismiss`;
their surface supplies dialog semantics and a label. The coordinator owns scroll
locking, background inert state, top-layer Escape/outside dismissal and focus
return after the modal barrier is released. Use `subscribeOverlayInteraction`
for custom menu keyboard/outside handling instead of competing document listeners.
Host shortcut routers can use `hasOverlayLayers()` to defer Escape.

Background notices use `passive`. Their first presentation waits until a modal
releases the document; already visible notices retain their rank behind later
modals. Start dismissal timers inside the admitted content and pause them while
`useHasModalOverlay()` is true. A notification stack uses a layout-only
`OverlayRegion`, with one `OverlayLayer` per card. The region and scroll ancestors
must not introduce a stacking context (z-index, fixed positioning, transform,
filter, isolation or paint containment); apply material and motion to each card.
Panel-local views and noninteractive export render trees remain local content.

## FlowChat tool cards


FlowChat frameworks use an attention model rather than a size or border model:

- `AmbientToolCard` keeps routine tool traces lightweight and glanceable.
- `ProminentToolCard` gives attention-worthy results a framed summary, a stable
  left content region, hover/focus-revealed right actions, and controlled detail
  disclosure.

Import these components from the dedicated product-surface entry:

```tsx
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  AskUser,
  ChatComposer,
  ChatComposerContent,
  ChatComposerEndActions,
  ChatComposerStartActions,
  CommandToolCard,
  ContextCompressionToolCard,
  FileOperationToolCard,
  ProminentToolCard,
  ProminentToolCardSummary,
  ReadFileToolCard,
  ToolCardCopyButton,
  ToolCardChangeSummary,
} from "@openbitfun/ui/flow-chat";
```

`ChatComposer` owns the reusable 32px context band and the compact/expanded
40px/120px input-surface anatomy. Product consumers keep their editor, menus,
model selection, voice input, sending, stores, and localized copy, and supply
them through `contextBar`, `startActions`, `endActions`, or the equivalent
compound slot components. The compound form is useful when a complex consumer
needs to keep those sections adjacent in source while the package still owns
the final DOM layout.

`AskUser` is the controlled question-and-answer interaction for FlowChat. It
owns native single- and multi-selection semantics, responsive option anatomy,
custom text input, submission feedback, and the answered disclosure summary.
Consumers keep question parsing, localized copy, draft persistence, and answer
submission outside the package and provide them through typed props.

Prominent headers keep information roles stable: `action` is the static primary
label, `content` is the secondary flexible subject, `extra` is right-aligned
dynamic metadata, and `actions` contains controls revealed on hover or keyboard
focus. Use `ToolCardChangeSummary` for added/removed counts; domain icons and
interaction affordances belong in `actions`, not in the summary.

Concrete tool-card views compose those frameworks without importing product
state. The published families cover file and command execution, search and web
results, agent and session activity, Git and review summaries, page lifecycle,
code execution, todos, images, and other routine tool traces. Each view owns its
card anatomy, status presentation, disclosure behavior, and action placement.

Tool-specific data shaping, localization, host actions, stores, and heavy
renderers remain in the consuming product and enter through semantic props,
callbacks, and slots. Bespoke product workflows remain product-owned rather
than being forced into a standard package view.

Field labels follow their orientation: horizontal labels use the 13px semibold
label role, while vertical labels use the 11px regular meta role. Field helpers
use secondary content with 16px leading at the default 11px font size;
FormSection descriptions use primary content with 16px leading at 13px. Both
leading roles scale with user typography. FieldGroup uses the form group tint,
retaining its existing row padding, dividers, and radius. The Patterns form
specimen shows both orientations and long values over a tinted container.

Menu and Listbox row surfaces are separated by `overlay.menu.rowGap` (2px),
including grouped options and the Listbox used by Select, Combobox and MultiSelect.
This is distinct from `itemGap` (icon-to-label spacing) and `sectionGap` (8px).
Menu keeps its 30px row height and no extra heading-to-item gap; separators and
adjacent sections account for the row gap instead of adding it twice.
The menu keyboard focus indicator stays inset so scrolling does not clip it.

The list owns spacing; individual rows never add compensating margins. `Menu`
and `MenuSection` use `MenuList` internally. If custom scrolling, animation or
other markup wraps a collection of MenuItems, use `MenuList` immediately around
the rows (for example, `<ScrollArea><MenuList>...</MenuList></ScrollArea>`).
Flex gap only reaches immediate children, so a plain wrapper loses that contract.
Product code owns positioning and viewport limits, and must not patch private
list/section-items/group-options gaps. A deliberate density variation belongs
on the owning surface via `--openbitfun-overlay-menu-row-gap`.

ActionItem hover and pressed surfaces use the semantic neutral hover fill;
pressed text remains semibold. Menu and navigation captions consume the final
caption color directly, avoiding a second opacity multiplier. The nested-menu
Pattern includes a scrolling toggle for keyboard and submenu verification.

Compact tabs use `size="sm"` (30px, 14px icons, 4px icon gap); standard tabs retain 40px and 16px icons. Tabs share the outline-button surface contract and keep selection separate from pointer press. `SegmentedControl size="md"` uses a borderless 36px bar with 30px segments, 3px inset, 4px gaps and 12px segment padding. The default `sm` bar keeps its 28px outer height; separate pills retain their existing heights. Mobile controls own their touch geometry independently.

Dialog titles use 24px bold type with their own 29px line box and normal tracking. `DialogHeader` and `DialogFooter` omit separators by default; pass `separator` for a deliberate divider. A direct `DialogBody` sibling of `DialogFooter appearance="floating"` owns the trailing scroll inset automatically. The floating footer provides the 68px centered action area and a masked blur/gradient using the current theme surface; reduced transparency and forced colors use an opaque fallback. Keep scrollable form content inside `DialogBody` instead of adding a second viewport with independent footer spacing.

Extra-large (`xl`) dialogs have an 800px maximum width and continue shrinking within the viewport gutter. Provider editing uses the floating footer; small workspace creation retains its attached footer and existing button/input sizes. The Lab workspace pattern uses local sample paths and callbacks only.

Keep `Dialog` and `Sheet` mounted and set `open={false}` to close them. They retain the last committed children during the exit animation, with interaction disabled, so clearing an owner selection does not collapse the surface. Reopening uses the latest children and cancels the pending exit. Owners that conditionally mount an editor can remove it in `onExitComplete`, which runs once after the surface unmounts.

PageHeader `md` uses the settings title with a primary 15px description; `display` uses the welcome heading and medium 17px introduction with a 12px gap. ActionCard uses 12px padding, section-heading typography (15px semibold), and a primary 13px single-line action description. Its inset outline does not inflate the 62px medium minimum height; longer content keeps the independent sibling actions and OverflowText behavior.

KeyHint uses 10px text on a 10px line and 2px block padding. StatusPill uses a 14px line with 2px block padding; opt into `emphasis` for short mode labels such as Ask, while ordinary status descriptions retain readable content colors. LauncherButton owns a 72px minimum width, 40px height, 10px side padding, 4px gap, 12px icon and 11px monospace text. Product shells may retain a deliberate compact greeting that expands into this geometry.

Composer and ChatComposer share the 16px surface radius, 8px padding, 12px content gap, composer border, context tint, and composer shadow. Compact ChatComposer uses a 24px action track plus 8px padding on each side and two 1px borders (42px border-box height); expanded height follows editor content. The generic context shell has no duplicate outer border or surface inset. Queue and editor state remain owned by their existing slots and product adapters.

ActivityItem `surface` uses a 40px minimum row with a centered outline, 12px
radius, 9px block padding, 12px leading inset and 9px trailing inset. The 22px
sibling actions fit inside that row; optional detail grows beneath it. Inline
activity retains its compact geometry. Identity text can shrink alongside a
long description while metadata and sibling actions retain their own slots.
Lab Patterns includes long paths, large change counts, expandable detail and
disabled actions. The current Web UI has no direct ActivityItem consumer;
FlowChat ambient tool cards keep their separate presentation contract.

Ambient FlowChat summaries, product thinking/explore headers and runtime status
share a 14px icon column followed by a 4px gap. The icon column starts at the
transcript body edge; heading text starts 18px after that edge. Loading, tool
and disclosure glyphs occupy that same column. Expanded thinking prose remains
aligned with the body edge; bordered tool detail retains its own content inset.
The 12px/4px Figma inline trace is a smaller typography scene; the existing
product 14px glyph size is retained when applying its gap to these summaries.

FlowChat vertical composition uses an 8px item/section gap and 4px inline gap.
Collapsed ambient tool runs use their 22px minimum line boxes without extra
spacing between adjacent rows; expanded/prominent cards retain the section gap.
The enclosing composition owns those gaps, and card bodies own their internal
padding. The Lab tool sequence demonstrates both arrangements with real cards.
