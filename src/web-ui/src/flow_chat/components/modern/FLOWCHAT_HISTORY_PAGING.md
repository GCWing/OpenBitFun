# FlowChat History Paging

The anchor renews its settle budget only when a correction reduces its measured
residual (or reaches tolerance), or while a missing Turn is still awaited.
An ineffective correction is remembered for that exact anchor/viewport geometry;
it is retried after geometry changes or a new anchor is captured, not on every
frame. Identical resize notifications do not renew the budget. The comparison
includes the anchor's content coordinate, so displacement at unchanged total
height still opens a settle. Item changes, snapshot restores and host resumes
remain explicit settle triggers. No sign-change count or overall time limit
terminates valid corrections.

Older Turns are fetched when the reader approaches the head of the loaded
window, prepended above them, and paid for by moving the viewport down by
exactly what arrived. This document covers the whole of that: when the ask goes
out, what may refuse it, how the displacement is repaid, and how the reading
position survives the measurement that follows.

Read alongside `FLOWCHAT_VIEWPORT_REGISTER.md` — the two repairs described here
are the only writers that do not take their turn in the priority order — and
`FLOWCHAT_VIRTUALIZATION.md`, which owns the measurement behaviour they depend
on.

## A Page Is Asked For a Screenful Early

A history page is not a quiet event, and no amount of care makes it one. The
items arrive above the reader and everything below them moves; the virtualizer
picks its window from a scroll offset it only learns from scroll events, so for
one commit it renders from a position the reader has already been moved off and
the transcript below the junction goes blank; the rows then measure and the
whole thing settles a second time. Watched frame by frame, at 1/8 speed: the
loading notice disappears, the tail of the previous Turn leaks out, everything
past the junction goes white, the viewport shifts up and clips the top of a user
message, and then it is fine. Four frames, twice, at the two junctions the
reader crossed.

Every one of those steps is correct. The reader still called it a flicker and a
jolt, because they were looking at it.

So the ask goes out while the boundary is still a screenful away —
`HISTORY_BOUNDARY_LEAD_SCREENS`, measured against live geometry rather than an
item count, since one item here is anything from a 38px user message to a
5012px model round. The page then lands above the viewport: the mis-aimed
window, the blank and the re-measurement all happen where nobody is looking, and
the reader scrolls up into content that is already there and already measured.
It costs one page of history fetched sooner than strictly needed, and nothing on
session open, where the boundary is a whole transcript away.

The pixel rule is a union with the item rule, not a replacement. A window short
enough that its head is on screen has no screenful of lead to offer, and that
case is the one the item slack was written for.

**The lead widens the ask and nothing else.** `historyBoundariesReached` is a
separate function for that reason: the arming latch below disarms a direction on
dispatch and re-arms it when the reader is no longer at the boundary, so serving
the latch from the wider answer leaves a boundary the reader can never be off.
Measured, with the two sharing one predicate: a 43-Turn session loaded one
window of five Turns, and every ask afterwards was refused as `not-rearmed` —
39 refusals over six minutes, the reader scrolling into a wall two Turns from
the top of what was loaded. The two questions look alike and are not: *has the
reader arrived* is about them, *is it worth asking* is about the fetch.

A pass can therefore re-arm and ask in the same breath, which is the point
rather than an oversight — "off the boundary, and a screen from it" is exactly
the state the lead exists to serve.

The lead is one screen rather than several because it only has to outlast the
fetch. At a brisk wheel scroll the reader covers a few hundred pixels in the
time a page takes to arrive from local storage; a longer lead just loads history
nobody reaches.

## Two Refusals Stand Between an Ask and a Page

`flowChatHistoryBoundary.ts` decides that a boundary is worth asking about.
Whether the ask is honoured is the container's, and it declines twice:

**While follow-output owns the viewport.** The position the ask was derived from
is then our own placement, not the reader's — as true of a history window being
opened as of the live tail, so the test is ownership and not presentation mode.
Ownership ends the moment the reader scrolls, which is exactly when the ask
starts meaning something.

**Until the visible range has left that boundary.** Prepend compensation puts
the viewport back on the reader's content, but the virtualizer places its rows
from a scroll offset it refreshes a frame later, so for one commit the visible
range is still read against the head. A direction is disarmed on dispatch and
armed again by the range leaving it — by `historyBoundariesReached`, never by
the wider ask; an ask that resolves to anything other than `applied` re-arms
immediately, because nothing was prepended and the range sitting at the boundary
is still the reader's own position.

Both were free under react-virtuoso: `firstItemIndex` moved the reported range
with the prepend, so the local start index jumped by the number of items added
and the rule stopped applying by itself.

**A gesture that moves nothing still asks.** The evaluation used to hang off
the `scroll` event, which is the one signal a reader at the top cannot produce:
the wheel changes no offset, so no event fires, so nothing asks. Combined with
the ownership refusal that is a closed loop, and it was measured as one. A tail
window of three Turns fitted inside the viewport, which put the entire scroll
range inside the reserved blank:

- at the bottom of that range no row intersects the viewport at all, so
  `getVisibleItemRange` returns nothing and there is no position to judge;
- at offset 0, an evaluation may still be refused while follow-output owns the
  opening placement;
- and at offset 0 the reader's own gestures produced twenty `user-gesture`
  claims over seven seconds with no scroll event, no anchor capture, and not
  one evaluation.

Scrolling up did nothing, permanently. So `notifyUserScrollIntent` evaluates
too, after it has cleared follow-output's ownership — which makes the ask the
reader's rather than our placement's, and gives the top of the range a signal
it can actually emit.

The empty visible range is traced (`historyPaging.noVisibleRange`) rather than
returned from in silence. Reading that session, the absence of an anchor
capture was the only way to tell "nobody asked" from "the ask was refused".

**The ask reads ownership as of now, not as of the last render.** A gesture
releases follow-output synchronously and then asks, so a render-time mirror of
`isFollowingOutput` reports the ownership the gesture has just ended.
`isFollowingOutputNow` is the hook's own ref, and the refusal reads it — in the
log, `followOutput.exit` and `historyPaging.refused:
follow-output-owns-the-viewport` sat at the same millisecond, three entries
apart, and the ask was refused for an ownership one line older than itself.

**`exhausted` describes the window that asked, not the session.** "There is
nothing before this" is a fact about a start ordinal. Navigating to the first
Turn asks `before`, the store answers `reached-start` for `targetOrdinal: -1`,
and that is correct — but only until the window moves. Only `applied` used to
clear the latch, which is the single case where the window moves *because* of
the page; every other way it moves left the old answer standing. Measured: 3
Turns of 43 loaded, `before` latched from a visit to Turn 1, and after jumping
back to the tail the reader could not page at all.
`warnHistoryPagingRefusedWithPendingTurns` fired
(`latched-exhausted-while-partial`) and nothing acted on it. The latch is now
cleared whenever the window's ordinals change.

## Keeping the Viewport on the Reader's Content

When history is prepended, the items arriving above the reader push their content
down by their own height while `scrollTop` stays the number it was.
`VirtualMessageList` adds that height back, in a layout effect, before anything
else observes the new transcript. The amount is read from the virtualizer's
placement of the item that *used to be first* — the height of exactly what
arrived, a delta and not a total.

This is the half of `firstItemIndex` that keying measurements on item identity
does not supply, and it was left out of the TanStack migration. Everything
downstream assumes it holds, and three separate failures were that one
assumption breaking:

- The virtualizer re-windows from its own scroll offset, which lags a frame, so
  it renders the head. The paging rule reads that as the reader having arrived
  at the head, and pages again — **five pages in 890ms on session open, and a
  single junction paging a transcript back to its first Turn**.
- The anchored Turn falls outside that window, so the anchor cannot find its
  element, drops the anchor, and corrects nothing. Measured: **655px of history
  arrived and `scrollTop` held at 23**, leaving the reader at the top of a block
  they never asked to see.
- With the reader left at the head, the paging boundary never re-arms and
  history becomes unreachable.

The arriving items are estimates until they measure, so this lands close rather
than exactly; the anchor — which can now find its Turn — takes it the rest of the
way. It writes as `layout-correction`, so the register refuses it while anything
above is moving the viewport on purpose: a navigation reaching a Turn, or the
follow loop re-asserting its target, both of which already say where the reader
belongs.

## A Displacement Is Not a Movement

Two things repair displacement rather than choose a position, and neither goes
through the priority order in `FLOWCHAT_VIEWPORT_REGISTER.md`: the prepend
compensation, and the viewport anchor. Both are `viewportOwner.shift`, which
asks a different question — content moving under the reader changes what their
offset *means*, and restoring that meaning is not competing with anyone over
where the viewport should be. So they are refused only by an owner that holds a
target and will re-assert it: follow-output or a navigation still reaching its
Turn.

The two are not redundant. The compensation is a pixel delta applied in the
commit that prepends, and it is the only thing that can act when the reader's
Turn is not rendered. The anchor restores a relationship, so it is the only
thing that can act on a re-measurement landing *after* that commit — which is
the majority of the movement, since the arrived items measure over the frames
that follow. Measured: a compensation of exactly the DOM's own growth (949px)
still left the reader at the end of the transcript, because the transcript then
shrank 200px in the next 21ms.

**The anchor cannot act in the prepend commit itself.** The virtualizer chooses
its rendered window from a scroll offset it only learns from scroll events
(`calculateRange` is memoised on `getScrollOffset()`, and `scrollOffset` is
assigned in the `observeElementOffset` callback and nowhere else), so the commit
that prepends is still windowing the position the reader has just been moved
off. Their Turn is in the DOM a frame later. This is why the anchor keeps an
anchor whose Turn is missing rather than dropping it on the first miss: dropping
threw the reading position away one frame before it could be used, at four
junctions in a row and not one correction between them.

**A gesture is not one of them, and must not be.** The reader chose a position
in the transcript, not a number of pixels. Ranking these under `user-gesture`
was a total failure rather than an intermittent one, because history pages in
*only* while the reader scrolls up into the boundary — so the gesture was
holding the viewport every single time either of them had work to do. Measured:
2494px of history arrived and the compensation was refused, `scrollTop` held at
40, and the transcript jumped back thirteen Turns; in the same session the
anchor stood down 23 times and corrected nothing at all.

Correcting during a gesture is safe for the reason the anchor already re-anchors
on every scroll of the reader's: within that window the anchor is tracking them,
so a correction is zero unless something else really moved. Outside it, nothing
changed — the claim had already lapsed.

**The amount is the smallest of three bounds**, because each of them
over-states and they do so for different reasons:

| Bound | Over-states when |
|---|---|
| `prependedPx` — height the arrived items measure, read back from the cache | the arrived items are not all rendered, so some of them are still estimates |
| `scrollRangeGrowthPx` — what the scroll range actually gained | the transcript also grew *below* the reader in the same commit |
| `contentEndPx - scrollTop` — what the range can absorb | never; content arriving above the reader cannot push them past the end |

Overshooting is the expensive direction. It puts the reader below the content
end inside the reserved blank. Undershooting leaves them looking at slightly
earlier content, which the anchor removes.

**The cache is measured before it is read.** Left alone it is not close:
measured twice in one session, 2174px reserved against 670px of real growth,
then 2494px against 949px — and the whole nineteen-item transcript came to
1236px once measured. That gap is not a virtualizer being approximate, it is a
guard in the library. `measureElement` resizes an item inline only when the
reader is holding still:

```js
if ((!this.isScrolling || this.scrollState) && ...) this.resizeItem(...)
```

History pages in precisely when they are not. So at a junction the rows are in
the DOM at their real heights, the cache holds the estimates it reserved for
them, and the ResizeObserver that would have reconciled the two does not deliver
until after the layout effects of the commit that added them — one frame later
than the compensation, which has to move the reader in the same paint as the
rows that displaced them. `virtualizer.measureRenderedItems()` does that
reconciliation itself, first thing: the same work, a frame earlier, and free for
any row whose height was already right (`resizeItem` returns on a zero delta).

`prependCompensated` still records all three numbers, so the remaining gap
between `prependedPx` and `scrollRangeGrowthPx` is a reading rather than an
inference — and now it is a reading of how much of the arrived block was never
rendered, not of how far behind the cache is.

## The Viewport Anchor Owns Scroll Compensation

A virtualizer places items in the scroll range before it knows how tall they
are, so every late measurement rewrites the offset of everything below it.
Correcting for that is unavoidable. Doing it with `scrollTop` is not possible:
the same number means a different place after every measurement. The reading
position is therefore recorded as a **Turn and its offset from the viewport
top**, and restored as a relationship rather than replayed as a delta. That
makes the correction idempotent — when nothing moved it is zero.

**The anchor is the only compensator.** The virtualizer's own adjustment is
turned off (see `FLOWCHAT_VIRTUALIZATION.md`) because it replays a delta against
a scroll position it learns about a frame late. Restoring a relationship has no
base to go stale, which is the whole reason this is the one that stays.

This was not always true, and what happened when it was not is why the rule is
written down. react-virtuoso corrected by the change in *total* list height,
which assumes the change happened above the viewport — scrolling up into a
freshly paged block guarantees it did not, and one item measuring 38px -> 1003px
moved the viewport 965px, across a whole Turn. Worse, the correction was gated
on scroll direction, and its own prepend compensation set that direction to
`down`, disabling it for exactly the measurements that followed: `scrollHeight`
went 8393 -> 10073 with `scrollTop` held at 1133 and no correction at all,
sliding the transcript down by the full 1680px. Those corrections had to be
intercepted at `scrollBy` and answered by re-anchoring. **Do not reintroduce a
compensator whose amount is a total rather than a delta.**

**Capture is qualified by intent, not by geometry.** A scroll event cannot say
whether the user moved or the transcript moved under them, so a *new* Turn is
taken as the reading position only within `USER_DRIVEN_SCROLL_WINDOW_MS` of a
wheel, touch, key, or scrollbar press — the same distinction follow-output
draws. Two rules were tried and measured first, and both failed in ways worth
recording:

- Capturing at the intent event itself records the position *before* the scroll
  it causes, which drags a scrolling viewport backwards.
- Gating on "the content height did not change" blocks almost every capture,
  because lazy measurement changes it on nearly every frame: 1075 blocked
  captures against 8 accepted ones, and a 1037px correction issued against the
  user's own gesture.

**A scroll may not replace an anchor that is owed a repair.** While the anchored
Turn is missing from the rendered window the displacement exists and cannot yet
be measured, and re-reading the anchor from the DOM takes whatever *is* rendered
at its already-displaced position — which files the displacement away as the
reader's own choice. Measured across five history junctions: the anchor was owed
104px, then 140px, then an amount never established, and at three of the five a
scroll 77ms later replaced it before the Turn came back. Two of the three were
never corrected at all.

Refusing the scroll outright is not the answer either — paging up is something
the reader does *while scrolling*, so the anchor would fight them for the whole
settle. So the anchor is **carried** instead: their travel is a change to
`scrollTop`, and it is subtracted from where the Turn is expected to be, leaving
only the part the transcript moved outstanding. When the Turn renders, the
correction is that part and none of their scrolling — however far they got.

**Falling outside the intent window is not grounds for ignoring a scroll.** The
window runs from the *input* event while the scrolling it authorises outlives
it: a wheel notch smooth-scrolls for longer than 200ms, and a main thread busy
with streaming delivers one coalesced event carrying the whole travel after the
window has closed. Ignoring it leaves the reader's own movement credited to
nobody, and the next settle undoes it in full. Measured over 181 seconds of
reading: fourteen gestures, **one** capture, and seven corrections between 308px
and 618px that each returned the viewport to exactly where its gesture had
started — the reader could not get anywhere.

So a scroll has three answers, not two, and the third is the same **carry**:

| | |
|---|---|
| **Captured** | A recent intent event. The Turn they arrived at is the new reading position. |
| **Carried** | Not provably theirs, and no registered writer owns the viewport. Nothing else changes `scrollTop`, so it is theirs. |
| **Left alone** | A registered writer owns the viewport. It chose that position; the stored relationship is not rewritten on its account. |

Carrying is safe here for the same reason it is safe anywhere: a displacement
moves the transcript *under* a viewport whose `scrollTop` does not change, so
carrying is a no-op for exactly the case the anchor exists to repair.

The third row changes nothing the reader can see — a restore carries the anchor
through whatever moved the viewport anyway, by the rule below — and it is kept
because the stored offset then goes on meaning "where the Turn was when the
reader last agreed to it", which is what the trail is read as.

**A displacement moves the transcript under a `scrollTop` that stays put.** That
is what makes it a displacement, and it is the rule the correction is computed
from: whatever `scrollTop` has changed by since the anchor's offset was agreed
belongs to whoever changed it, and only what is left over is drift to repair.

The alternative was in place for a long time and is what "scrolling down pulls
me back" turned out to be. The settle loop reads `scrollTop` from the DOM; a
commit opens a window on almost every frame; the scroll event carrying the
reader's travel is delivered after all of that. So a correction routinely runs
against a reading position agreed hundreds of pixels ago, with no capture in
between, and reads their own scrolling as drift. Measured over one reproduction,
ten corrections: **every one of them was the reader's travel**, the largest
putting a 508px scroll back where it started while the transcript had really
moved 7.8px.

Note what this does *not* weaken. A displacement contributes nothing to
`scrollTop`, so taking the movement out never takes any of the repair with it —
when the reader has not moved, the correction is what it always was.

**The offset and the viewport position it was agreed at are two halves of one
fact, and every writer moves both.** That is the invariant, and it is the whole
of why the movement is taken *into* the anchor at the top of a restore rather
than subtracted inside the correction. Subtracting it leaves the two halves free
to drift apart: a frame with nothing to correct advanced only the position, and
the reader's travel became a debt the next frame collected. Measured, with the
subtraction in place: a 32px scroll and an 81px scroll each reported back a
frame later as a correction of exactly itself, the anchored Turn provably not
having moved. Worse, the subtraction made that frame the *ordinary* outcome —
with the movement taken out, a frame in which only the reader moved corrects by
exactly zero.

There is one movement of `scrollTop` that must not be taken into the offset, and
it is the repair itself: the shift puts the Turn back at the stored offset, so
the position advances by the correction and the offset stays.

The baseline is therefore carried, not re-taken. It used to be re-set to the
current position every time a settle window opened, on the grounds that the
prepend compensation had written from the layout effect just before and that
write is not the reader — which was true of the compensation and false of
everything else the reset swallowed, the reader's own travel first among them.
The compensation now says so itself, through `absorbViewportShift`: it is the
one movement made on the anchor's behalf, so it is the one that must not count
as somebody moving the viewport.

**The anchor must be a Turn the reader can see, at both edges.** A Turn's marker
is its user message, which is short, so a reader inside an answer taller than
the viewport has no marker on screen — and "the first marker below the top
edge" then answers with the *next* Turn, however far down it is. Measured: an
anchor held at an offset of 1695.5px in a scroller at most 1325.7px tall, at
least 370px past the bottom edge.

The two directions are not symmetrical, which is why the bottom edge is a bound
and not a preference. Content above the viewport re-measuring moves everything
below it, the on-screen transcript included, so a marker above the fold is a
faithful proxy for what the reader sees. Content *below* the viewport
re-measuring moves nothing they can see — so a marker down there reports
movement that never reached the screen, and correcting to it **creates** a
displacement instead of repairing one. No anchor is the honest answer, and it is
what this already gave once every marker had gone off the top.

**A navigation replaces the reading position; it does not displace it.** Standing
down for the register is not enough — that postpones the correction for the
length of the hold and no longer. A Turn navigation therefore drops the anchor
outright before it aims, and the settle window opened by the commit that renders
the placement takes the new one. Measured over four clicks on one Turn: the aim
placed the viewport at 287px each time, and each time the anchor put it back
1653px away on the first frame after `ONE_SHOT_NAVIGATION_HOLD_MS` lapsed, still
anchored to the Turn the reader had jumped away from. The re-capture cannot
happen in the aim's own task: the target is commonly outside the rendered window
when the aim is issued, so reading the DOM there anchors to whatever the reader
was moved off.

**Restoring needs a window, not a callback.** A prepend settles over several
frames — a margin holds the position, the real heights land in padding, then the
margin is released — and *a margin change fires no ResizeObserver at all*, so no
single callback covers it. Every signal that the transcript moved therefore
opens `ANCHOR_SETTLE_FRAMES`, and a frame that had to correct refreshes it — as
does one still waiting for the anchored Turn to be rendered, since "not there
yet" is neither a repair nor a failure. Without that, the settle outlasts the
wait only for as long as `ANCHOR_SETTLE_FRAMES` and
`ANCHOR_MISSING_TURN_ATTEMPTS` happen to be the same number, which is a
coincidence and not a design. Measured before the window existed: four
consecutive painted frames displaced by 896px.

The observer feeding this had to be repointed. `scrollerRef.firstElementChild`
is a viewport-sized box that stays at the scroller's height no matter how much
transcript there is — it never reported a content change at all, despite a
comment claiming it watched content. The item list is the element that grows,
and `border-box` is required because the virtualizer parks item space in
padding.

**The keeper does not know there is a virtualizer.** It lives in
`flowChatViewportAnchor.ts` (geometry and the DOM contract for the anchor
element) and `useFlowChatViewportAnchor.ts` (capture, restore, and the settle
window), and it talks to a scroller element and the Turns rendered inside it and
to nothing else. That is what let the virtualizer underneath it be replaced
without the keeper changing at all.

One consequence of the refresh rule is worth stating plainly: a frame that finds
the anchor already in place consumes the remaining settle budget rather than
refreshing it. The cost is a `querySelectorAll` and two rect reads per frame for
the bounded settle window. A correction or a Turn still waiting to render
refreshes the window, while a stable anchor winds it down and another owner
holding the viewport still stands it down.

The anchor is skipped entirely while follow-output owns the viewport. Restoring
a pre-prepend position is only meaningful when the user owns it — and a frame
spent standing down is *not* evidence the settle is still running. It looked at
nothing. The loop used to refresh on the missing-Turn count instead, which is a
fact about the last frame that did look, and that count can only advance on a
frame that does not stand down: the same condition jammed the loop and put its
only exit out of reach. Measured at the tail after a jump-to-latest, where
follow-output does not release because resting there is what it is for: 27
seconds of `anchor.stoodDown`, one per frame, zero travel, ending only when the
reader scrolled. The wait it reported for that — `waitedFrames: 6609`,
`waitedForMs: 28116`, against 20 attempts — was of a reading position that had
been correct the whole time.

So the outcome of a restore is five-valued inside the loop, not a boolean.
`false` covers a stand-down, a Turn not rendered yet, and no anchor at all, and
the loop has to treat those differently; the public `restoreAnchor` still
answers the only question its other callers ask.

**What the anchor cannot fix on its own** is a scroll range that was wrong to
begin with. Holding the reading position across a burst of measurement is worth
nothing if the burst blocks the main thread for 295ms. That is a property of how
unmeasured items are reserved, not of the anchor, and it is why the virtualizer
underneath it takes a per-item estimate.

## The Ask Is Derived From the Transcript, Not From the Window

**A page asks for what lies past the transcript on screen.** Those are the same
range only until the continuous projection splices a window starting at ordinal
0 with the live tail: the rendered transcript then runs to the newest Turn while
the store's window still ends where it was paged in. `resolveHistoryBoundaryTarget`
therefore takes the *rendered* range, and the store's window stays what the
extension below operates on.

Deriving the ask from the store's window instead asks to load a Turn that is
already on screen. Measured, in a live session: a window paged in from the tail
ended at ordinal 6 while the session had grown to 10, so the reader was sitting
on the newest output with a `history-window` presentation behind it. Reaching
the bottom asked for ordinal 6 — which the *turn catalog* could not resolve
either, because it still held the six entries it was built with. 266 asks, every
one answered `not-found`, none of them recorded, and a boundary status the
reader was shown as history being prepared for a transcript that was already
complete.

Three things had to be true for that to reach a reader, and each is fixed where
it belongs:

- The ask used the wrong range. That is the bug; the rest is how it stayed
  visible.
- **`reached-latest` is not `beyond-known-total`.** Asking past the newest Turn
  is what the bottom edge of a live transcript answers every time the reader
  arrives at it, and it must not raise the missing-history alarm. Asking past
  the known total going *backwards* still does.
- **A load that fails records an outcome.** `not-ready` and the superseded
  cancel both returned silently, which is why the trail held 266 asks and no
  answers at all. The cancel also left the boundary status reading `loading`
  forever; the status is ours to clear even when the load was not ours to
  finish.

The status the reader sees is separate again, and is in
`FLOWCHAT_SCROLL_STABILITY.md`'s footer contract only insofar as the sentinel
lives there: **a boundary in `error` must not be labelled as one in
`loading`.** Both ends now pick their label by state. One label for both is why
a permanent failure read as permanent progress, and why cancelling the Turn did
not clear it — nothing about the Turn was ever involved.

## Reading History Is About the Transcript, Not the Intent

`viewportMode: 'history-reading'` does two things — it suppresses streaming
follow, and it pins the jump-to-latest bar open and routes it through a
presentation reset. Both are asking one question: **does the transcript on
screen still reach the newest Turn?**

A turn-navigation viewport intent used to answer that faithfully, because turn
navigation was the only thing that activated a history window. It is not any
more. A session whose loaded tail is shorter than the viewport pages older Turns
in the moment it opens, with nobody navigating, and the first paging step has to
set a turn intent — `isShowingHistoryPresentation` requires one, so without it
the paged-in Turns would not render at all. The viewport sitting on the newest
output was therefore reported as reading history: the bar was visible from the
moment the session opened, clicking it dropped the window and paged it straight
back in, and streaming output was not followed at all.

`flowChatLiveTailWindow.ts` answers it from the window's own ordinals instead.
These are ledger numbers, not measurements — the rule against inferring intent
from geometry is about ambiguous quantities like `scrollTop`, and does not
apply. The answer also keeps up on its own: a Turn arriving past the end of the
window flips it back with no help, where a flag recorded at activation time
would go stale and leave no way to the live tail.

`isReadingTurnViewport` keeps its old meaning for the auto-tail placement, which
asks a third question again — who owns the viewport. Merging those two is the
mistake this separates.

**A tail-anchored window must grow with the session.** It stops at the newest
Turn that existed when it was cut, and nothing moves its end afterwards, so an
appended Turn is simply not rendered. That is worse than it sounds: `latestTurnId`
comes from the ledger, so follow-output learns the Turn exists but cannot reveal
it from a projection that has no matching item; the arrival remains pending with
nothing to scroll to. `resolveTailWindowGrowth` is
level-triggered for that reason. An edge — "it reached the tail last render and
does not now" — is consumed whether or not the extension succeeded, stranding
the window permanently on one failure; the current state stays `'extend'` until
the window is actually repaired. A window the user navigated to has a different
end, so the session growing says nothing about it and it is left alone. When the
store cannot extend far enough, the fallback drops back to the canonical tail:
that costs a visible re-page of the history above, which is why it is the
fallback, but it is the only branch that always shows the message just sent.

## A New Turn Is a Fact About the Session

`latestTurnId` comes from `activeSession.dialogTurns`, never from
`virtualItems.at(-1)`. The projection answers where the presentation currently
*ends*, and a history window re-cut moves that to a Turn which has existed for
hours: measured, navigating to Turn 2 landed correctly and was then overwritten
twice, because each window loaded on the way ended somewhere new and each of
those read as a submission, moving the window's last Turn as though it were new.

**Whether the Turn can be acted on is a second question, and it does not belong
in the identity.** Qualifying `latestTurnId` by "and it is on screen" makes a
Turn that merely came into view look new — the same bug with the opposite sign,
and it is how navigating to Turn 29 ended on Turn 38.

**An arrival is not a change.** Getting the identity right does not settle how
to *detect* one, and the detector asked whether `latestTurnId` differed from
last render. A rollback truncates `dialogTurns`, which moves that identity
backwards onto a Turn that has been there all along — so undoing a message
moved the Turn *before* it as though it had just arrived. `dialogTurnCount` separates the
two: an arrival grows the ledger, and nothing else that rewrites `dialogTurns`
— a history page merging in above, a window re-cut, a hydration — moves the
last Turn at all, so requiring growth costs nothing and excludes every
truncation.

**A rollback then says where to land, because the ledger cannot.** A shorter
`dialogTurns` is also what a window re-cut and a hydration merge look like, and
two dozen call sites write that array; inferring an action from its size is the
same mistake as inferring intent from `scrollTop`. So the rollback announces
itself through `FLOWCHAT_TURNS_ROLLED_BACK_EVENT`, exactly as a submission does,
and the transcript settles on the new tail.

It takes the viewport whether or not follow owned it. A rollback at Turn N
removes N *and everything after
it*, and the reader had N on screen — they clicked its own button. So the new
tail is always within a Turn of where they already are, and there is no history
below them to be pulled out of. Gating it on ownership instead — the first
attempt — made it dead code in the case it was written for: reaching a Turn far
enough up to want it gone means scrolling, and scrolling is what hands the
viewport back to the reader. The viewport anchor then answered instead, and
answered a different question: it holds the reader's Turn at its offset from the
viewport top, so an 8-Turn session rolled back at Turn 7 came to rest showing
Turns 2..6, with the new last Turn's answer below the fold. Nothing was wrong
with the anchor. It was the only thing still running.

The event fires a frame after the truncation, because the answer is a scroll to
the end of *real content* and that has to be read from a DOM the truncation has
already been committed to. Edit-and-rerun does not announce: its truncation is
followed by a rerun whose Turn really is new, and announcing would spend a
visible movement on the way to it.

So the response carries it instead. A new Turn is answered by revealing the
resident tail blank with one physical-bottom placement; until the Turn is in the
live-tail projection there is nothing to reveal, and the old content end is not
a stand-in because it can pull a reader out of a history window before the new
Turn exists there. The answer is therefore **deferred, not dropped**: held in
`pendingNewTurnIdRef` and retried when the transcript next changes, which is
exactly when the presentation is restored to the live tail.

**Submitting is what gives up a navigated window.** `resolveTailWindowGrowth`
leaves such a window alone as the session grows, and that is right — a Turn
arriving from anywhere else must not take a reader out of the history they are
in. Nothing in the ledger separates that from a Turn the reader sent themselves,
so the composer says so directly: `useMessageSender` announces
`FLOWCHAT_MESSAGE_SUBMITTED_EVENT`, and the container gives up the window only
when the transcript does not already reach the latest Turn. Measured before it
existed: a message sent while parked on the first Turn left the transcript on a
24-item window it was never in, with follow-output holding an answer it had
nothing to align.

## Restoring a Session Reading Position

Switching sessions remounts the virtual list, so preserving a reading position
cannot depend on keeping the old scroller or virtualizer alive. The container
keeps a session-scoped snapshot of the rendered history presentation, viewport
intent, and the first visible virtual row's stable key and offset from the
viewport top. The Turn id remains a compatibility fallback, but a long Turn may
have its user message offscreen while a model round is visible, so the exact row
is the authoritative identity. Restoring the session reinstates the presentation
first, then restores that row-and-offset relationship through
`viewportOwner.shift` and opens the ordinary anchor settle window so later
measurements keep it stable.

The saved `scrollTop` is only a materialization hint when the anchor Turn has
not entered the rendered virtual window yet. It is never the final answer: once
the Turn exists in the DOM, its semantic offset is authoritative. A snapshot
whose reader was away from the tail also suppresses the session-open tail
follow, including when the reader was using the ordinary tail projection rather
than an explicit history window. Snapshot publication remains gated until that
relationship is within rounding error for two painted frames: provisional mount
geometry must not replace the saved snapshot or re-enable automatic tail
placement while restoration is still in flight.

## Diagnosing History Paging

Older Turns are paged in when the viewport reaches the head of the loaded
window. Every way that handshake can fail is **silent and identical in the UI**:
the boundary status returns to `idle` and no indicator is shown, so "declined to
load" is indistinguishable from "there is no more history". The failure is also
intermittent, so it is traced permanently rather than reproduced on demand.

`historySessionDiagnostics` keeps a per-session ring buffer shared with the
hydration timeline, and the two log channels carry different things:

| | `flowchat.log` | `webview.log` |
|---|---|---|
| carries | the full paging step stream | the refusal alarm + its trail |
| enabled by | `app.logging.flow_chat_diagnostics` | always on |
| written via | `flowChatDiagnostics.trace` | `log.warn` |

The in-memory trail is kept regardless of the flag, so
`warnHistoryPagingRefusedWithPendingTurns` is **self-sufficient** — the recent
events travel with the warning and no one has to reproduce the fault with
diagnostics turned on first. It warns once per session, so scrolling against a
dead boundary cannot flood the log. Turn the flag on only when the trail's
30-event cap is not enough.

Two detectors raise it:

- `exhausted` returned for `beyond-known-total`. That result **latches the
  direction off for the rest of the session** and only `applied` clears it, so
  reaching it on an unknown or contradictory total is how history goes
  permanently missing rather than merely late.
- A `before` request blocked by that latch while the session is still
  `isPartial`. This fires at the moment the user scrolls up and nothing happens.

When the report is "scrolling up shows no history, but the Turn Rail can still
load those Turns", search the log for `declined to page older Turns`. Turn Rail
navigation goes through `loadSessionTurnWindow` directly and bypasses the
boundary latch entirely, which is why it keeps working. The accompanying
`FlowChat history paging trail` warning carries the preceding events, including
`anchor_capture_failed` — `captureHistoryPrependAnchor` returning `false`
cancels a window that was already fetched.

The viewport side of the same junction is traced separately; see *Diagnosing the
Viewport* in `FLOWCHAT_VIEWPORT_REGISTER.md`, and in particular the pair of
numbers that separates "the compensation overshot" from "the transcript
re-measured".

## Related Files

- `flowChatHistoryBoundary.ts`
- `flowChatViewportAnchor.ts`
- `useFlowChatViewportAnchor.ts`
- `flowChatLiveTailWindow.ts`
- `VirtualMessageList.tsx`
- `ModernFlowChatContainer.tsx`

## Moving Between Main and Floating Hosts

An explicit host move stages `SessionViewportState` through
`flowChatViewHandoff.ts`: semantic viewport snapshot, history presentation and
viewport intent. The source captures through `VirtualMessageList`; the receiving
host restores through the existing viewport owner. No separate scroll writer is
introduced. A render may inspect the pending handoff, but only a committed host
consumes it, so interrupted renders cannot discard the reading position.
Handoffs are fenced by device activation and session identity. Each host keeps
its own display projection and composer geometry; Runtime history stays shared.
