# FlowChat Virtualization

## Historical scrolling and measurement

Manual scrolling keeps the host's native wheel/touch behavior. Perceived
smoothness depends on stable content coordinates as well as frame time; adding
an easing loop to a height correction would expose the correction as motion.
The implementation follows the read-before-write guidance in
[rendering performance](https://web.dev/articles/rendering-performance) and
[layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing).
No new motion is introduced, so the existing reduced-motion policy and follow
targets remain unchanged.

Newly attached rows are measured as one batch in the layout phase, including
while the reader is scrolling. The library's `measureElement` still registers
observation, but it skips its inline size update during a gesture; the adapter
therefore supplies the already-read height through `resizeItem` in that commit.
In this flow layout the real row heights affect following content immediately.
Waiting for ResizeObserver lets the old virtual padding and real rows disagree
for a visible frame.

Explicit item/offset aims retain the library's own attachment-measurement policy.
A smooth aim intentionally leaves distant rows estimated: forcing their sizes
can move its target and make the library replace the animation with an `auto`
jump. Reader intent cancels the aim before scrolling, so newly attached rows
resume synchronous measurement in the first reader-controlled commit.

Above-viewport measurement shifts pass through the viewport register and credit
the DOM anchor with the **actual applied** displacement. Otherwise the anchor
counts that repair as reader travel and applies it again. The anchor remains
independent of the virtualizer; the list joins these two owners.

The native scroll handler shares one `flowChatViewportGeometry` sample among
leading-extent, anchor and session-snapshot readers. It is local to that event,
and discarded if a follow write changes the offset. Layout commits, resize and
navigation read fresh geometry; this is not a cross-frame cache.

The packaged macOS WebView fixture (80 Turns with Markdown, code, tables and
collapsed tool groups) reproduced 17 reverse frames during 72 fast upward wheel
actions, with a maximum 499.45px reversal. After these changes the same five
slow/fast bidirectional phases had zero reversals over 4px and zero blank frames;
row/scroller rectangle reads fell from 37,331 to 28,489 across those phases.
Fast-up frame intervals still reached 26ms at p95 and 53ms at maximum in the
final run; continuity is established here, not a constant 60fps guarantee.
These are instrumented native-WebView samples, not physical trackpad or
cross-platform latency measurements. See `FLOWCHAT_VERIFICATION.md` for the
repeatable fixture and its limits.

## Accepted steering display

The host queue's optional `steeringDisplay` receipt projects an accepted message
after its target Turn, without changing recorded rounds or writing a second
history record. Full display text and composer references come from the host;
pending attachments show their count rather than retransmitting image bytes.
Accepted text messages use the ordinary user-message appearance without a pending
status label; internal admission state still disables edit and rollback actions.
Formal Turn handoff keeps the original queue Turn id and the preview's virtual
key. Canonical history replaces the preview even when events precede the receipt.
Queue disappearance alone is not consumption: the observer queries the receipt
and retains the pending shell until history arrives. Blocked messages show a
not-applied label and restore composer recovery controls.

Only mounted transcript projections lease hidden queue rows. History windows
without the target, older hosts without display receipts, and closed transcripts
retain queue controls. Leases and previews are isolated by queue client, surface
activation and host queue epoch. Restart recovery remains with the existing
outbox; mobile retains its existing queue presentation. No scroll placement or
mount animation is added, and execution order remains host-owned.

## Measured row spacing

`VirtualItemRenderer` establishes a `flow-root` on the measured wrapper so
descendant block margins remain inside its border box. A row replaced by virtual
padding must retain its full occupied height, including trailing item spacing.
Do not substitute clipping overflow: user-message decorations and controls can
extend outside the reading column. The rhythm test protects this stylesheet
contract; it does not prove browser layout or end-to-end scroll stability.

Embedded panels must preserve that shared formatting context. The Btw sidebar
previously overrode the wrapper with `display: block`, allowing trailing child
margins to escape measurement. Removing a boundary row then removed space not
represented by virtual padding; tail follow could bring the row back, restoring
the space and removing it again. `BtwSessionPanelLayout.test.ts` protects the
cascade contract. `BtwVirtualSessionList.test.tsx` reproduces the feedback with
supplied contained/escaping margin geometry, the real virtualizer, and delayed
resize/scroll delivery. This isolates a window-churn mechanism; native WebView2
memory savings and the fraction of observed runtime churn it explains still
require a retest.

## Completed-turn metrics

The resident completed-turn footer keeps `FlowChatTurnMetrics` on the left and
elapsed time with the existing actions on the right. Only elapsed time is shown
inline; its shared Tooltip exposes the completion timestamp and elapsed time.
Metric typography and Lucide glyph sizing belong to `@openbitfun/ui`.
The completed-turn copy menu contains one export-as-image action alongside the
copy actions, without sections. It prefers opening below the copy button, aligned
to its trailing edge, and flips above when the lower viewport space is insufficient.
The shared anchored-position hook keeps it attached during nested scrolling and
viewport or content resizing, with viewport-edge clamping and no transcript writes.
The export action opens a shared Dialog with two selectable
cards with matching 224×168px footprints, reducing only their width in narrow
panes. Public CardHeader actions and CardBody slots compose the checkbox and
preview without overriding Checkbox anatomy. Whole-card activation selects the
shared Checkbox; its checked mark indicates
the single selected output without changing the card border. Hover and keyboard
focus use the semantic neutral hover surface; pressing uses its pressed surface.
Only the background transitions, using shared fast motion with a reduced-motion
fallback, so interaction never changes the card geometry. Equal, compact
preview frames consume semantic surface/content/accent tokens directly and
distinguish a reply-only preview from a larger accent-tinted
expanded thinking panel and the reply content. Pointer activation and arrow/Home/End
keys select an output without starting capture. Export requires confirmation. Cancel and Escape leave the
transcript untouched and restore focus to the resident trigger. The trigger shows
export progress and stays disabled until capture finishes; the exporter stays
mounted when the menu and Dialog close. There is no separate image action in the footer.
The capture keeps the live transcript column width and typography, with a
standalone image inset that grows from space-4 to space-8. It uses the live
user-bubble tokens, with right alignment, borderless quiet fill and complete text rather
than the live view's three-line clamp. Persisted reference capsules reuse the
live message's content renderer. Compact output omits thinking items entirely,
including their icons; the other output renders expanded thinking in item order.
The small brand/date header and muted attribution footer use semantic typography,
spacing and divider tokens, without an assistant slogan or subtitle.
Round wrappers contain their child margins with `flow-root`: the rasterizer
freezes computed heights, so collapsing those margins outside a round before
cloning loses each inter-round gap in the SVG and leaves their sum above the
footer. Tool summaries remain inside the image inset.
The image capture copies resolved CSS properties, including browser-prefixed
paint properties, but excludes inherited custom properties from the cloned SVG.
The staging DOM receives the initiating transcript column's measured width and
inherited theme variables, including local font settings. It keeps the shared
reading-column maximum as a fallback when the source row is no longer mounted;
the full pane width is never used as the text width. Exported text uses the live
renderer styles without extra inline padding or export-only link no-wrap rules. Repeating
the full theme catalog on every cloned node makes long transcripts expensive to
serialize and rasterize. Capture validates the canvas before adding the logo:
uniform or transparent output is a failure even when PNG encoding would succeed.
A failed raster retries at reduced scale; a timeout stops the export. Logo
compositing reuses the validated canvas and its actual scale, avoiding a second
full-size bitmap and keeping reduced-resolution exports aligned.
Capture waits for web fonts before measurement and embeds used faces, preserving
the bundled HarmonyOS/Fira metrics on Windows/Linux as well as system fonts on
macOS. Logo geometry is read after fonts settle, before staging DOM cleanup.
Generative UI card PNG exports use the same capture helper, including blank-image
rejection and reduced-scale recovery. Encoding failures must not write files or
show success. Timed-out captures release any raster that completes late.
Each number has its own hover/focus/click capsule and details card. Clicking
opens immediately and keeps the card open until another trigger click, an outside
press, Escape, or scrolling; native button triggers also support keyboard activation. `FlowChatMetric`
shares the selected-text capsule's surface material and preserves the existing
Tooltip overlay ownership; borders are reserved so hover does not resize rows.
Shared Tooltip visibility immediately closes cards and cancels pending opening on
any window/container scroll, releasing click persistence without viewport writes.
Viewport-exit observation also covers clipping caused by non-scroll layout changes.
The details card paints its background, border, shadow and backdrop filter on
the same outer surface, with an opaque fallback. Tooltip owns its entrance
motion so the global popup animation cannot add another opacity layer.
Only the session's latest turn shows its footer at rest. History rows share
temporary hover/focus leases through the view's reader state, including across
separate virtual blocks. Only the footer subscribes, and row recycling releases
its leases. Open footer overlays keep their trigger row visible. Hidden footers
retain their measured space and keyboard access; the typewriter reveal gate
still takes precedence. Latest-turn identity comes from the session catalog,
not the last visible virtual row or the end of a history window.
The cache ring uses reported cache-read tokens divided by input tokens; if any
call lacks cache telemetry, the turn's ratio stays unknown. TTFT has a separate capsule showing request-to-first-effective-output latency
for the first model call (the accepted attempt after a retry). Text, thinking and
tool output count as effective output; metadata-only packets do not. The host
reports this optional duration, so controller clock skew and event delivery
latency do not affect it. The speed levels use output tokens divided by the sum
of each call's first-effective-output-to-stream-end time, with thresholds at 15,
40 and 80 tokens/s disclosed in the Tooltip. HTTP setup, TTFT, tool execution and
post-stream usage persistence are excluded. Missing or inconsistent timing in
any model call, or retries whose earlier attempt timing is unavailable, omit speed
rather than substituting turn wall time. Negative-index controller setup/audit
rows are presentation only and do not participate in either metric.
Legacy records omit unknown TTFT;
reported zero remains valid. Timing survives the normal history save/load path. Total usage and the cache ring form one unit,
hidden only when both values are missing. If usage is known but the cache ratio
is unknown, a neutral dashed ring remains; cache-only data adds no total placeholder.
Other unavailable metrics and detail rows are omitted; reported zero remains visible.
The row retains its existing reveal reservation and has no mount animation or
viewport writes. Narrow panes may wrap the two groups without clipping actions.

## Interrupted turn continuity

Cancelled rounds remain in the ordinary transcript. The display projection removes
only the terminal legacy `stream_error` diagnostic whose serialized error starts
with `Cancelled: `; genuine failed attempts keep their retry history. Saved data
is unchanged. A recovery generation and a preceding cancelled round place a quiet
continuation label inside the next visible model-round row, including when empty
cancelled rounds precede it. That boundary prevents cross-round grouping from
hiding the label; ordinary within-round tool folding remains available. Round ids
and virtual row keys stay unchanged, with no viewport writes or mount animation.

Retry history seals the preceding collection once, while the current effective
attempt starts a new collection that can receive following model rounds. Attempt
normalization must not disable grouping for the whole round. Failed attempts stay
in their independent history disclosure and never join the current collection.
For old records, the display policy disregards an unqualified
`disableExploreGrouping` hint only when multiple recorded attempts all use the
native Runtime identity `<round-id>:attempt:<index>`. Explicit host policies carry
the optional `disableExploreGroupingSource: "host"` provenance; older hints with
unrecognized attempt identities remain authoritative. Projection never rewrites
the saved hint, attempts, or member identities.

## Measurement compensation and cached offsets

Geometry updates and React rendering have separate delivery contracts. The
virtualizer updates its size cache, applies owner-approved compensation and
publishes the physical offset synchronously. Its local core adapter coalesces
render requests within a commit and permits at most 16 notification-driven
commits before yielding to an animation frame. The frame renders current state;
it does not retain a scroll target or replay a former owner's write. Cleanup
cancels the frame, including session remounts and StrictMode effect replay.

This bounds a converging measurement cascade as well as an oscillating one:
many near-empty rows can require more than React's nested-update limit while
the window replaces estimates with measurements. Do not defer only the opening
reconciliation callback: follow layout effects and physical range clamping can
also advance the window. Explicit `measureRenderedItems` remains synchronous
for callers that must read geometry before the next React commit. Normal small
cascades still settle synchronously; the budget reset alone causes no render.
`useFlowChatVirtualizer.cascade.test.tsx` covers tiny and zero-height rows,
convergence across frames, reader takeover and remount cleanup using real hooks
and supplied geometry. It is not proof of the production crash's data trigger
or native paint timing.

When the viewport owner accepts a shift for a measured row wholly above the
reader, the virtualizer publishes the actual scroll offset after updating its
size cache, before selecting the next rendered window. This applies during
ordinary reading as well as opening reconciliation. Waiting for the native
scroll event leaves the old offset paired with new row positions and can remove
newly measured rows, then mount them again on that event. A refused shift does
not trigger this readback. All viewport writes remain with the existing owner.
`useFlowChatVirtualizer.initial-window.test.tsx` covers delayed scroll and
scroll-end delivery using the real virtualizer and supplied geometry; it does
not establish browser performance.

## Collapsed thinking content lifetime

Thinking cards mount their Markdown body only while expanded or finishing a
collapse transition. Initially collapsed rows therefore do not parse or build
hidden Markdown when virtualization remounts them. Closing content is released
when the actual grid transition finishes or is cancelled; without a transition
(including reduced motion), it is released immediately. Reopening invalidates
the pending release. The typewriter and reveal gate retain their existing
lifetime. `ModelThinkingDisplay.test.tsx` covers this lifecycle with supplied
animation promises; browser animation fidelity and scroll performance still
require runtime verification.

## Embedded session lifetime

`BtwSessionPanel` keeps a lightweight tab-owned wrapper while its content is
inactive. Its transcript and observers unmount immediately. `BtwVirtualSessionList`
shares the virtualizer and stable row keys; `useBtwPanelViewport` saves a visible
row key and intra-row offset while reading, then restores against estimated and
mounted geometry. Readers following output return to the live tail. The shared
`useExploreGroupState` accepts initial expansion state for this remount boundary;
the primary transcript retains its existing default and session lifetime.

## Opening a session marks it read

Navigation row clicks acknowledge the current unread result immediately.
`useSessionReadOnOpen` also acknowledges results when the main session or Btw
panel is open in an active scene and a focused, visible document, including new
results received while it stays open. Inactive scenes and background windows
retain unread results. This policy does not inspect transcript hydration, row
geometry, scroll position, or result visibility. Device surface changes invalidate
pending callbacks; host-summary acknowledgements prevent stale refreshes from
restoring the same unread result. Paused recovery and pending interactions remain
independent of read state. The hook performs no viewport writes.

What the virtualization library is allowed to decide, what stays ours, and the
one rule about rendering that only makes sense once a row's lifetime is shorter
than its content's.

## What Belongs to the Virtualizer

On a tail-following open, the virtualizer seeds its initial offset at the last
item's estimated start. A desktop trace previously mounted rows 0..13 before
moving to 22..33, with 372.3ms charged to the first head-row measurement. The
seed selects a tail window without first mounting the head; real heights and
the existing follow owner still determine the settled position. This is a
one-time seed, not an ongoing tail lock. Initial empty hydration waits for items
before consuming it. History-window presentation and saved reading-position
restoration retain the default initial window. Tests cover window selection
using the real virtualizer with supplied DOM geometry. A same-session desktop
retest started at rows 27..33: rowRef total fell from 377.3ms to 4.2ms and the
post-reveal probe completed at 806.7ms instead of 1540.3ms. This is a single-trace
comparison, not paint timing or remote validation. The remaining tail-window
contraction led to the measurement reconciliation described below.

Opening measurement reconciliation now runs after a row size enters TanStack's
cache and before the queued render chooses its next window. Only an active,
unsuspended, still-opening transcript whose current owner is `follow-output`
asks the existing follow scheduler to reconcile. The offset observer then
publishes the actual scroll position without a synchronous React flush. No
displacement permission is broadened, and historical reading, user takeover,
and post-reveal streaming keep their existing rules. A pending debounced native
scroll-end sample must not overwrite this publication with its older offset.
The motivating trace measured a 729px shrink of rows 22..26 followed by window
contraction/remount and 113.8ms of removal-related style work. Tests reproduce
the contraction with reconciliation disabled and retain the same row nodes
with it enabled, including a delayed native scroll event and scroll-end timer.
A same-session desktop retest kept rows 22..33 mounted: row cleanup calls fell
from five to zero, and the post-reveal probe completed at 596.4ms instead of
786.8ms. This single-trace comparison does not establish paint timing or remote
behavior; other main-thread stalls remain.

Opening follow corrections also publish their immediate `scrollTop` readback
through `syncViewportOffset`, including a target that is already reached. The
list connects the follow callback to this adapter method; follow never imports
the virtualizer. Only active, unsuspended opening follow with viewport ownership
publishes, and refused writes publish nothing. Equal offsets do not notify React.
This lets range selection proceed before the native scroll event without adding
a synchronous flush or clearing measured sizes. Measurement reconciliation uses
the same observer channel, with its pending flag cleared before calling follow
to avoid recursive correction. Native events remain enabled. Tests withhold them
and check window expansion, node retention, stale scroll-end delivery and user
takeover; runtime savings and remote behavior still require separate validation.

FlowChat virtualizes with **TanStack Virtual**, behind `useFlowChatVirtualizer.ts`.
Nothing else imports it. The rest of FlowChat asks for offsets in scroller
coordinates and gets them back; there is no index space of the virtualizer's own
to convert at the edges, because measurements are cached against **item keys**,
so a history prepend leaves every measured item exactly where it was.

That is only half of what react-virtuoso's `firstItemIndex` did, and the other
half has to be supplied — see *Keeping the Viewport on the Reader's Content* in
`FLOWCHAT_HISTORY_PAGING.md`.

The reason it is TanStack and not react-virtuoso is one line of its measurement
pass: `size = measured ?? estimateSize(i)`. A per-item estimate for everything
unmeasured. react-virtuoso reserves a single scalar (`lastSize`) for all of
them, and this transcript alternates 38px user messages with model rounds up to
5012px, so the scroll range was wrong by an order of magnitude until an item was
actually measured. `estimateVirtualMessageItemHeightWithContext` now feeds it
directly. The estimate is owned by the data shape in
`virtualItemHeightEstimators.ts`: text, thinking, user messages, model rounds,
Explore groups, and tool families each derive a bounded height from their
content, status, width, and expansion state. This code is pure and runs before
a row has a DOM node. Once mounted, DOM measurement remains authoritative and
replaces the estimate. Width and volatile Explore expansion changes invalidate
only the derived position pass; TanStack's key-based measured-size cache is
retained.

**Items stay in normal flow inside a padded window**, not absolutely positioned.
Everything outside the window stands in as `padding-top` and `padding-bottom`
(`virtualWindowPaddingPx`). This matters for more than tidiness: when an item
inside the window changes height, the browser reflows the ones below it in the
same layout pass, so there is no frame where the scroll has been corrected but
the items have not moved yet.

**The virtualizer does not use TanStack's own late-measurement adjustment.**
`shouldAdjustScrollPositionOnItemSizeChange` reads the real scroller position
and asks the viewport owner to apply the delta only when the whole item is above
the viewport. A partly visible row is left alone because its changed content is
inside what the reader is looking at. TanStack's adjustment is always refused:
it applies its delta to `scrollOffset`, the library's copy refreshed only from
scroll events. Every continuous writer here assigns `scrollTop` directly and
the matching scroll event lands a frame later, so that base can be stale. The
owner's displacement is applied before the new size enters the cache, while
the anchor remains responsible for restoring relationships across larger layout
transactions.

**Measurement is forced before any position is read in the commit that changed
the items.** The library skips its inline resize while the reader is scrolling,
which is exactly when history arrives, so the cache holds reserved estimates
until the ResizeObserver delivers a frame later.
`virtualizer.measureRenderedItems()` does that reconciliation itself — the same
work, a frame earlier, free for any row whose height was already right. The
evidence and the numbers are in *A Displacement Is Not a Movement* in
`FLOWCHAT_HISTORY_PAGING.md`.

**Alignment is asked for, not computed, wherever it fits.** `scrollItemIntoView`
goes through the virtualizer so that its re-aim keeps chasing the item while the
measurements under it move; an offset computed once is already stale by then.
The gap above a top-aligned Turn is the virtualizer's `scrollPaddingStart`, for
the same reason. Only two places compute an offset by hand, and both do it
because the target is not an item: the end of *real content*, which is above the
resident tail spacer, and the end of a Turn.

Two things that look like they belong here do not:

- **Positions in `virtualItems`.** That array is FlowChat's own projection, so
  an index into it means the same thing under any virtualizer. `scrollToIndex`,
  `scrollToSearchMatch`, and `data-virtual-index` all carry one and are left
  alone.
- **When to page.** `historyBoundariesForVisibleRange` decides that a boundary
  is worth asking about, from where the reader stands and nothing else. Its
  thresholds are the ones that decide *where* a junction happens, which is why
  they are named and tested rather than inline.

**Visible is not rendered.** `getVisibleItemRange` intersects the rows with the
scroller box; the rendered window carries overscan, and a transcript short
enough to render whole reports the first *and* last item present wherever the
viewport stands. Feeding the rendered window to a rule that means "has the
reader arrived here" asks whether the item exists instead. Measured: a 21-item
transcript rendered rows 0..20 from index 0 no matter where the reader was, so
the head boundary read as reached forever. It has to be a callback rather than a
value, because a scroll moves the viewport across the window without changing
it.

react-virtuoso remains a dependency: the file tree (`VirtualFileTree.tsx`) still
uses it. Nothing under `flow_chat/` does.

## The Projection Is the Stable Thing

Stable virtual-item keys and projection identity are required. Do not split one
`ModelRound` into multiple virtual items, and do not reclassify projection from
a timer.

Search matches retain their concrete text source and occurrence, grouped once
by virtual-item index. Row containers receive no search background or outline.
`useFlowChatSearchPresentation` owns mounted text highlights and one passive
line overlay for the current occurrence: a neutral line tint with a short gutter
marker. The overlay uses the first painted text fragment in row-local coordinates,
so it follows outer scrolling without a viewport write. Resize, content changes,
and nested scrolling refresh its geometry; clipped or unmounted sources produce
no marker. Each row releases only its own CSS highlight ranges. Search states
change no row geometry, spacing, or mount animation. Navigation and expansion
remain in `VirtualMessageList`, separate from presentation.

`getVirtualItemStableKey` keys on type, Turn and content id — never on an index.
That is what lets a prepend renumber every row without React unmounting any of
them, and it is what the measurement cache is keyed on underneath.

Tool cards reflow naturally and dispatch only `tool-card-toggle` after an
expanded-state change, so the virtualizer can remeasure. There is no
pre-collapse intent event and no per-card compensation.

`SmoothHeightCollapse` starts its completion timer in the animation frame that
applies the target height. A delayed frame must not shorten the transition or
unmount closing content early. Reversing a toggle cancels both the frame and timer.

User-message text and both message-edit inputs use the same `flow-control`
font-size role as the composer and rendered replies, following the user's font
preference. User-message text also uses the reply's regular weight. Its
first-line box must use that same font size when deriving row geometry.

User-message timestamps and actions occupy a normal-flow meta row below the
bubble. Its full height, including the 28px action targets, belongs to the
measured message even when no valid timestamp is available. The timestamp and
actions remain visible at rest, without requiring hover or keyboard focus.
Editing and rollback share one edit-icon menu trigger, labelled "Edit and rollback".
The public MenuPopover owns anchoring, dismissal, keyboard navigation and focus
return. Opening it performs no history mutation; selecting a row enters the
existing edit or rollback flow. Each row retains its visibility gates and disabled
reason, including remote-workspace and detached-dispatch restrictions. An open
menu keeps the resident action cluster visible while focus moves into the portal.
The menu leaves measured row geometry and viewport ownership unchanged.
`_transcript-layout.scss` owns the reading-column inset shared by user-message
shells, model rounds, Explore regions, and the runtime-status footer.
The messages viewport enables a shared outer column rule for virtual rows and
the runtime footer: reserve the turn rail's offset and hit area plus space-1 on
the leading side, and only space-2 on the trailing side. Columns remain centered
when there is room for the full 900px reading width. This rule is local to the
transcript; the composer and welcome surface keep their existing widths, and
embedded transcripts without a rail keep their own layout. The scroller remains
full width.
The shared content-padding token defaults to 0.75rem on wide and narrow surfaces,
keeping the reading column compact while leaving room for decoration and targets.
The borderless bubble ends at the reading column's trailing content edge, with
inner padding matching its corner radius. Bubbles fit their content without a
minimum width. Collapsed previews are capped at 28rem and the shared message-width
limit (72% of the column, up to 48rem by default). Text after the third explicit
line break is kept in a span outside layout while collapsed, so hidden long lines
do not contribute to intrinsic width. The visible prefix sizes the bubble; CSS
still clamps wrapped text to three visual lines. A generated ellipsis marks the
hidden suffix without changing the rendered-text coordinate sequence. Reference
capsules stay intact, and copy/edit continue to use the full source.
Expanding restores the suffix and removes the preview cap: the bubble grows
leftward as needed from the same trailing edge and downward up to its existing
60vh scroll limit. Editing retains the full reading-column width. Narrow columns
remain bounded by the shared width limit.
These changes use normal layout and the existing resize measurement path, with
no layout animation or viewport writes.
Both metadata rows align the last icon frame with the content's trailing edge,
retaining 28px hit targets and the same compact action gap. Each action cluster
wraps as a whole when space is limited. A half-space-1 gap groups user metadata
with its bubble; all geometry stays in normal flow. The shell's trailing
margin remains the item gap; the next Turn may remove
that gap without removing space occupied by controls.

MCP service references in user-message text render as ordinary reference capsules,
including text segments alongside persisted file or skill capsules. The display
reads the existing prompt syntax, so historical messages need no migration or live
MCP catalog lookup. It preserves the stored text and uses the existing row measurement
path, with no mount animation or viewport writes.

Reference capsules align their label's text baseline with adjacent message text.
The label participates in flex baseline alignment while the icon stays centered;
the capsule's padding and the label's intrinsic line box do not set the outer
alignment reference.

## A Row's Mount Is Not an Arrival

**No mount-triggered enter animation may live inside `.virtual-item-wrapper`**, no
mount-triggered motion may change transcript geometry, and nothing may be keyed
on a state change a scroll can replay.

Outside a virtualized list an element's insertion means its content arrived, and
a fade or a slide says so honestly. Here insertion means the row entered the
rendered window. Paging up mounts the Turns the page brought, the rows the
junction's own correction scrolls past, and every row the reader scrolls back
over afterwards — each one replaying whatever its stylesheet attached to mount.
`--streaming` to `--complete` is the same mistake in a different key: it fires
when the typewriter finishes, which is not when the reader is looking.

The one that shipped was `.markdown-renderer`, from the shared component
library: `animation: fadeIn var(--openbitfun-motion-duration-base) ease-out`,
350ms from `opacity: 0`. Once the junction displacement was down to tens of
pixels that fade was the entire remaining complaint — most of the screen
dimming and coming back on every page up. `VirtualItemRenderer.scss` cancels it
for anything inside a row and leaves the library alone, where a markdown block
really is mounted once.

An explicit local submission has a separate, transient presentation receipt.
`addSubmittedDialogTurn` registers it before the synchronous optimistic store
write; history hydration and remote replay continue through the ordinary store
path and never register one. The receipt includes the device activation, Session,
Turn, and message identity, expires after 300ms, and can be claimed by one
renderer only. It never enters persisted messages or wire payloads.

`useSubmittedMessageMotion` consumes that receipt to animate only the user-message
contents: the bubble moves 4px over 220ms; timestamp and actions move 2px over
180ms, starting at 60ms and 100ms. All three use the submission's clock, so a late
commit catches up instead of restarting. A virtualized remount has no claim.
The measured wrapper, full metadata height, virtual keys, and scroll owners stay
unchanged. Focus/pointer interaction, reduced motion, a hidden document, and device
activation changes finish feedback immediately. Unsupported animation APIs display
the settled message directly.

`RuntimeStatusSlot` may defer only its initial paint until 160ms after the same
submission; clearing the real status removes that delay immediately. Existing
runtime wait-status scheduling and first-token delivery remain independent of the
motion. The resident status slot retains its full height throughout.

The rule is stated here because four correct local fixes could not reach it.
`ModelRoundItem.scss` and `UserMessageItem.scss` each refuse a CSS mount animation
of their own, in comments that name this reason. `FlowTextBlock`'s typewriter
refuses to replay on mount, because a streaming block that scrolled out and
back would restart from an empty string and re-grow. `FlowTextBlock.scss`
cancels this very fade — but only under `.streaming`, so the one block still
being written was exempt and the whole of history was not. Each author saw the
defect, guarded their own file, and had no way to guard a component in another
package.

## Related Files

- `useFlowChatVirtualizer.ts`
- `virtualMessageListLayout.ts`
- `VirtualItemRenderer.tsx` + `.scss`
- `VirtualMessageList.tsx`

## Annotation markers

The shared conversation-excerpt inventory projects pending-queue attachments and
device-scoped composer drafts into indexes keyed by
source session and Turn. Each transcript consumes its own stable index; embedded panes do not select the parent
transcript. Removing a draft attachment or consuming its queued message clears its
source marks and highlights. Sent metadata retains the message snapshot and its
number, but never recreates source marks when history loads or streams.
The number is additive presentation metadata, never annotation identity;
legacy excerpts without it remain readable. New numbers follow the loaded session
family's saved, queued and pending annotations, not a cross-controller global counter.

`ConversationExcerptMarkers` paints numbered superscripts above the top-right
of each selected fragment's full text bounds in a row-local overlay. It measures
the badge group and overlaps the selection's upper-right corner by 6px on both axes,
leaving the marker body above the selected text. The marker may cover surrounding
text or another marker so a dense layout never hides the annotation.
Selection bounds use selected text runs, excluding full-width block rectangles.
Selections with different starts keep separate anchors even when
their ends match. It validates the frozen text anchor, clips partially visible anchors
to the row's visible bounds, omits fully hidden anchors, observes only
mounted rows and releases observers on unmount. It changes neither transcript text
nor row keys, row height, or scroll position. Persistent CSS highlights follow the
draft and queued annotation inventory and release their row-owned ranges on
unmount. Images and an annotation-count capsule share the composer attachment strip.
The capsule opens a hover/focus/click detail list with individual edit/remove actions.
Source superscripts and detail edit actions open `ConversationExcerptDialog`;
creation shares its compact editor content.
Both modes show one ellipsized, quoted source line, with both quote marks outside
the clipped text so the closing quote remains visible. Pending annotations use an
unlabelled textarea with an accessible name. Sent-message entries always view
their persisted comment as plain text in a bounded ScrollArea, even when a pending
copy has the same annotation ID. Viewing has only source navigation and the
Dialog close control; it exposes neither an editor nor a save/re-add action.

Editing or deleting a pending annotation from the source-marker dialog updates its
owning draft and visible attachment; queued changes update the frozen prompt,
display fallback and presentation together. The attachment editor shares the delete
action. Deletion discards unsaved comment changes and closes the dialog.
Sending or unsupported legacy queue payloads remain intact and report why changing
them is unavailable. Source marks disappear once they no longer have a pending
owner, and a stale editor cannot recreate or delete a consumed annotation.
Locate uses the existing viewport navigation owner, and explicitly saves changed
draft text before closing. Device activation fences apply to both writes and
navigation.

## Transcript row columns

Thinking, Explore, ambient tool summaries and the runtime-status footer use
`control.flowChat.rowIconSize` (14px) and `rowIconGap` (4px). The outer content
column owns its responsive inset. Borderless rows add no leading padding or
transparent border; text-only replies and expanded thinking begin at that same
body edge. A summary with an icon starts its label 18px later. Tool/arrow/status
layers keep their slot during state changes. Native SVG artwork may contain
internal whitespace; do not compensate for it with per-tool margins.

Thinking/Explore labels use secondary content directly and their icons use the
caption role, avoiding a second opacity multiplier. These layout rules do not
change virtual-item identity, measurement ownership or viewport writes.

## Transcript vertical rhythm

The shared item gap is 8px and the inline gap is 4px. Thinking, Explore and
retry disclosure headers share the ambient 22px minimum line box, growing with
text. Consecutive collapsed ambient tools remain continuous lines with no added
inter-item gap. The existing projection flag preserves that rule across virtual
model-round boundaries; expanded and prominent cards keep the ordinary 8px gap.

The item-rhythm mixin belongs to ModelRoundItem, retry-attempt contents,
Explore contents and the subagent projection. Leaves carry no outer margin.
Enclosed contents remove their last gap; model rounds retain it until the virtual
Turn boundary removes it. Expanded Task wrappers use the same parent-owned gap
as other items; their body owns its internal padding. Export wrappers and the
Lab sequence own their own gaps. Thinking/Explore content has an 8px top inset;
bounded Explore retains 8px bottom padding for its scroll fade. There is no
negative adjacent-region margin. The resident runtime slot stays 24px high and
continues to participate in the existing footer/reservation contract.

## Selection and custom highlight paint

Native transcript selections use the application selection style. Do not add
descendant `::selection` overrides to the chat root: WebKitGTK reports show
uncached highlight pseudo-style resolution during long-transcript repaint.

Search, temporary excerpts and persistent annotations use `flowChatHighlights`
to own both their CSS Highlight ranges and attributes on every intersecting text
parent. A range can span Markdown links/emphasis; marking only its first parent
loses paint. Each owner updates only its own parent set, shared parents are
reference-counted per document and highlight kind, and disposal cannot clear
another mounted row or pane. Attributes stay stable across unchanged updates
and are outside the annotation geometry observer's attribute filter.

The Appearance theme-token adapter projects the annotation accent's 30% tint
and indirect mixes in search/native-selection color tokens to concrete colors
when a theme is applied, including the chrome theme scope. Its renderer stylesheet supplies
existing semantic colors for sparse/legacy themes and system colors in forced
color mode; derived paint is not a persisted setting or a new theme token.
Scoped highlight rules remain in place without an active range, as with streaming
reveal. Moving color projection to its own stylesheet is an ownership decision,
not evidence of WebKit stylesheet-matching isolation or a measured speedup.

Linux/WebKitGTK long-session CPU and pseudo-style stacks still require runtime
verification. DOM tests establish range/marker lifecycle, not renderer performance.

## Streaming glyph presentation

The shared Markdown renderer paints newly appended text with
`useStreamingTextReveal`. Its CSS Highlight ranges fade on their own arrival
clock without adding nodes or changing geometry. Mounted history and virtualized
remounts start settled; stream completion does not restart the text. It does not
write the viewport, change row keys, or add a mount animation inside a virtual
item. Unsupported Highlight APIs and reduced motion display text directly.
