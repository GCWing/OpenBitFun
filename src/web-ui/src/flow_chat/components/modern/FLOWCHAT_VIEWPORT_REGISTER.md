# FlowChat Viewport Register

Anchor diagnostics distinguish `anchor.correct` (a requested shift) from
`anchor.correctionResult` (actual scroll travel, residual and progress). Results
include the trigger source, anchor row key, rendered first index/count, frame
timestamp, and cumulative correction/travel/reversal counts since capture.
Reversals are evidence, not a stop condition. `anchor.settleOpened` records
items/resize/snapshot/resume triggers and the previous budget; `anchor.settleEnded`
records the final outcome. Repeating events use the existing gated coalescer;
none contain message or tool content. Read suppressed counts as well as emitted
samples. These diagnostics do not prove that a correction painted on screen.

Every deliberate write to the FlowChat scroller goes through one register, which
decides whether the writer may act. This document covers the register, what it
replaced, the two writers that stand outside it, and the trail it leaves.

## Who May Move the Viewport at All

Continuous movement belongs to `useFlowChatFollowOutput`; one-shot navigation
belongs to `VirtualMessageList`. The virtualizer never follows output. Card
renderers and tool cards must not write the outer FlowChat `scrollTop` — local
scroll surfaces inside a thinking, explore, terminal, or subagent card may
manage their own scroll position, but they must not dispatch an outer viewport
compensation request.

## The Register and Its Order

Every deliberate write goes through `useFlowChatViewportOwner`, which asks
`flowChatViewportOwnership.ts` whether the writer may act. The order is the
design:

| | Owner | Held while |
|---|---|---|
| 1 | `user-gesture` | 200ms from the last wheel, touch, key, or scrollbar press |
| 2 | `one-shot-navigation` | a Turn, search hit, or focus request is being reached |
| 3 | `follow-output` | the continuous writer owns the viewport |
| 4 | `layout-correction` | the scroller's box changed and a resting viewport is re-aligned |

The register decides **whether**, never **where** — targets stay with the writer
that owns them, and the anchor's correction stays idempotent. Ordering answers
what idempotency cannot: whether a movement was ours on purpose or something to
be undone.

**Repairing a displacement is not on this list**, and putting it there was a
mistake worth keeping recorded. The prepend compensation and the viewport anchor
both use `viewportOwner.shift` — see *A Displacement Is Not a Movement* in
`FLOWCHAT_HISTORY_PAGING.md`.

**Taking ownership and writing are one call.** Adding a writer without declaring
it means not using the helper, which is visible in review — the register keeps
the deliberate movement owners explicit and leaves user-controlled positions
alone until another explicit action takes the viewport.

**Only an owner that releases may hold the viewport indefinitely**, and
follow-output is the only one — a claim with no expiry and no release is a
viewport nothing below it can ever write again. Every other writer states its
own window: a gesture goes quiet, an animation may never report completion, a
re-aim runs while measurements settle. Saying nothing means the write is
instantaneous and owns only itself, which is what a correction wants; the claim
still resolves against whoever holds the viewport, because that is the question
deciding whether the write happens at all.

The first thing this caught was its own: the virtualizer places the scroller
against its own state on mount, before any aim of ours exists. That 0px write
was attributed to a navigation and took an unbounded claim, so follow-output was
refused for the whole opening reveal and a long session opened at the head of
its loaded window instead of on the newest Turn. A library write nobody asked
for is now attributed to `layout-correction`, which is what it is.

**The opening reveal is not an owner.** It is a phase, and the thing moving the
viewport during it is follow-output, so a claim standing in for the reveal would
outrank follow-output and refuse it. One slot cannot hold a phase and a writer
at once, so the reveal remains an explicit condition beside the register.

Not everything collapsed into it, and the difference is worth keeping straight.
`smoothScrollFramesRef` is follow-output yielding to *its own* animation, which
is intra-owner; `settleFramesRef` is a frame budget; `boundaryArmedRef` is paging policy.
Only the parts that were really answering "is someone else moving the viewport"
are gone.

## What Counts as a Gesture

Selecting transcript text hands the viewport to the reader through the existing
user-gesture path. The selection toolbar waits for pointer release and uses a
portal; neither the toolbar nor its frozen annotation changes row geometry.
Returning to an excerpt reuses concrete text navigation: stable Turn/item ids
materialize only missing rows, then saved offsets and text context resolve the
selected occurrence. CSS highlights do not wrap or resize transcript nodes.
An edited or ambiguous source retains the quote and reports that it cannot be
located. Gestures, a new request, and surface changes cancel a pending aim.

Ordinary `scroll` events do not transfer viewport ownership; only explicit
wheel, touch, or keyboard navigation exits follow-output. Once a reader takes
the viewport, resting inside the reserved blank does not hand it back.

A scrollbar drag is the one exception, and the press is what makes it one: a
pointer held past the content box's trailing edge is on the bar, so the
scrolling it causes *is* intent. The press only arms it — `scrollbar-gutter:
stable` keeps the gutter reserved whether or not a bar is drawn there, so a
press that scrolls nothing changes nothing. Unqualified, a drag never released
the viewport: measured on WebView2, follow-output rewrote its target against the
thumb every frame for a 100px oscillation. Recognising the drag transfers
ownership to the reader, and their resting position is preserved.

## Reaching a Turn Is One Shot

One-shot Turn, search and history navigation lives in `VirtualMessageList`, and
holds `one-shot-navigation` for as long as it is still arriving.

**A readable search hit needs no placement.** Resolve a mounted text range before
asking the virtualizer to move. Advancing between occurrences on the same line
only changes passive highlighting; the readable area excludes the top fade,
bottom fade, and floating input. An offscreen text line is placed once through
`scrollToOffset`, replacing any item aim. Only an unmounted row needs coarse
item alignment to materialize it, and that aim ends as soon as the concrete hit
is reached. Previously every occurrence first centered its row and then its
text on another frame, while the row aim could still reassert itself later.
Gestures, a superseding search request, and session teardown abandon pending
search resolution. Search styling owns no viewport writes.

**The current Turn is not always the first visible Turn.** The top alignment
gap can leave a sliver of the preceding Turn on screen; the content-end clamp
can leave several earlier Turns visible. `VirtualMessageList` remembers the
accepted navigation target and reports it as current once it intersects the
viewport. Without a visible target, current still comes from the first visible
Turn. This identity affects the rail and current-Turn affordances only: it
never changes the scroll position, the viewport snapshot anchor, or the set of
visible Turns. A rejected navigation does not replace it.

Update that identity even when two targets produce the same clamped offset and
no scroll event fires. Ordinary placement/measurement scroll events must not
erase it. An explicit scroll gesture clears it, including a gesture that cannot
move the viewport; item/search navigation replaces it; returning to follow or
switching sessions clears it. The rail's single `aria-current` marker then
reflects the chosen visible Turn, not another Turn sharing its viewport.

The rail's pointer preview is separate from this navigation identity. Hover
temporarily gives primary ink to the pointed marker and widens it to 19px;
its three neighbors in each direction widen to 16px, 13px, and 11px, remaining
muted. Other markers stay at 10px. Leaving restores current-step ink without
navigating. Rail scrolling clears the preview, touch does not latch it, and
reduced-motion keeps the shape change but removes the transition. Fixed row
heights and hit areas keep this feedback out of transcript geometry.

**Alignment is asked for, not computed, wherever it fits.** A navigation
correcting its own scroll must re-issue through the virtualizer, never by
writing the scroller. The virtualizer keeps re-aiming at its last target for as
long as the measurements under it move, and only another scroll issued through
it replaces that. Writing the scroller directly is what left the tail Turn
top-aligning, being pulled to the content end, and being re-aimed at the top
again.

**The clamp branches on what is knowable, not on where the Turn is.** A rendered
Turn resolves its own offset, so the decision is made before anything moves and
the requested `behavior` survives. An unrendered one is known only to the
virtualizer, so it is placed with `behavior: 'auto'` and the landing read back;
an animated placement would not have arrived yet, so there would be nothing to
read. Both writes land in the same task, so the correction costs a second scroll
but not a second visible movement.

**Turn navigation never scrolls into the reserved blank to top-align a Turn.** A
Turn whose top lies past the content end is stopped at the content end instead,
which is where the tail rests. The blank belongs to follow-output's passive
new-Turn reveal, and nothing arrives under a Turn the user
navigated to. There is no "is this the last Turn" test and no measurement of
what lies below it: a Turn with a viewport of content under it has its top above
the content end already, so the clamp does not bind and the final Turns of a
long transcript still top-align. Before the resident spacer the browser did this
for free by clamping at the end of the scroll range.

**Top-aligning a Turn aims at `FLOWCHAT_TURN_TOP_GAP_PX` above its user
message**, not at the message itself. The first Turn already sits below that gap
for free, because `.message-list-header` occupies it at the head of the scroll
content; every other Turn used to land flat on the top edge, and the two read as
different alignments. The header renders at the same constant so they cannot
drift. This remains a Turn-navigation contract; new-Turn reveal no longer asks
for or re-asserts a Turn-top offset.

**A gesture preempts a navigation still in flight, and ends it.** The library's
re-aim keeps computing for up to 5s after the aim that started it, recomputing
the target offset from measurements that are still landing and writing again
whenever it moves.

Refusing those writes is not enough, and this is the one place the register's
guarantee stops short on its own. The refusal is invisible to the library — it
has no return value to read — so it keeps its schedule either way, and the
gesture's hold is `USER_DRIVEN_SCROLL_WINDOW_MS`, 200ms after the last wheel
notch. A measurement landing after the reader has stopped, and inside the
remaining five seconds, is granted. Measured on a rail click into a long
history window: placed at 5358, the reader took over 6ms later, and 12ms after
that the re-aim asked for 7784 and was refused — with nothing having ended it.

So `notifyUserScrollIntent` gives the aim up outright, through `cancelAim`. It
aims at the offset the scroller already holds: an offset aim carries no index,
the re-aim recomputes its target *from* the index, and writing again is the only
thing it does when that target changes. The library's `scrollState` is private,
and a cast into it is the kind of thing a version bump breaks silently.

The cost is accepted, and it is what the reader asked for: a distant navigation
the wheel brushes stops where it is and is not corrected further. In the
measured case that is 2460px short of the Turn that was clicked — the placement
is deliberately approximate, and the re-aim is what would have finished it.

**A hold postpones a corrector; it does not cancel one.** Standing down for the
register keeps a correction from landing while the hold is live, and hands it
over intact the moment the hold lapses. Where the movement being held off was a
*change of intent* rather than a displacement, that is not what was wanted, and
the register cannot know the difference — it ranks writers, it does not carry
meaning. Whoever changes the intent has to say so: a Turn navigation drops the
viewport anchor before it aims, because otherwise the anchor spends the hold
waiting and then undoes the jump. Measured over four clicks on one Turn: 1653px
back, four times out of four, each on the first frame after
`ONE_SHOT_NAVIGATION_HOLD_MS` lapsed.

This is also why a placement's outcome is sampled *after* the hold rather than
inside it. `turnNavigation.placed.outcome` used to read back at 400ms against a
600ms hold and reported `driftPx: 0` on a placement that was dragged 1653px away
11ms later — the probe could not see the one thing the hold was postponing.

## Why There Was No Coordinator Before, and What Changed

There was one — `FlowChatViewportCoordinator.ts`, removed alongside the
compensation engine, and it was a compensation engine itself: reservations,
pin and collapse compensation, element-anchor leases, a synthetic bottom range.
Nothing here does any of that.

The argument recorded against replacing it was that single-writer semantics were
unreachable, because the virtualizer writes `scrollTop` from inside the library —
its own re-aim, and its adjustment for a re-measured item — so a coordinator
could only serialise *our* writes while the conflicts in practice were with that
third writer. Two things retired that premise:

- The library's adjustment for a re-measured item is **off**
  (`shouldAdjustScrollPositionOnItemSizeChange`), because it replayed a delta
  against a scroll offset it learns about a frame late.
- **`scrollToFn` is a first-class virtualizer option.** Every write the library
  makes — `scrollToIndex`, `scrollToOffset`, and the re-aim that follows them —
  goes through a function we supply, so it is registered like any other.

What remains outside the register is the reader and the browser, and browser
scroll anchoring is off. A library write is attributed to whoever asked for the
aim, which is also what lets a gesture preempt a navigation still chasing its
Turn.

## Diagnostics Cleanup

The stability investigation's viewport, placement, tail-follow, and item-resize
probes have been removed. The viewport register still owns every deliberate
write, and the anchor and pager retain their behavior and focused tests.

The `app.logging.flow_chat_diagnostics` configuration and diagnostic log
transport remain available, but the viewport no longer emits that trail.

The log analyzer can still inspect logs captured before this cleanup.

## Related Files

- `flowChatViewportOwnership.ts`
- `useFlowChatViewportOwner.ts`
- `VirtualMessageList.tsx`
- `useFlowChatNavigation.ts`
- `scripts/diagnostics/analyze-flowchat-log.mjs`
