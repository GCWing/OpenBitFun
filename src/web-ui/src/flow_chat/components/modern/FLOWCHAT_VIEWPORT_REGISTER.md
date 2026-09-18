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

## Diagnosing the Viewport

Viewport faults are intermittent, leave nothing in the DOM once they are over,
and read identically to two or three other causes: a Turn that lands and is
dragged away and a Turn that never landed are the same complaint. So the trail
is permanent, in `flowchat.log`, behind `app.logging.flow_chat_diagnostics` —
the same switch history paging uses — and tagged `viewport`.

`flowChatViewportDiagnostics.ts` records two different kinds of thing:

| | Where | What |
|---|---|---|
| **Writes** | the register, `viewportOwner.write` / `.claim` / `.release` | who moved the viewport, from where to where, and **who was refused** |
| **Decisions** | each writer | why it wanted to move, and why it did not |

The second half is the one that pays. A write that never happened leaves nothing
at the register to find, and "nothing happened" has been the report more often
than a wrong move has: a deferred new Turn, an anchor whose Turn left the
rendered window, a boundary declined because the transcript was opening, or a
boundary that never re-armed. Each of those is now one line saying
which.

**A placement is recorded with what became of it.** `traceViewportPlacement`
samples the offset on the next frame and again once things have settled, and
reports the drift from the target. Read against the register's writes in the
same window, the drift says *who* took it away. Every deliberate write now goes
through the register; the two that did not are both gone, and what the sampling
found before they went is worth keeping, because in both cases it was not what
the probe was written to catch.

**The focus request was overriding, not overridden.** A usage-report click
lands a Turn navigation through the register and then centres the flow item
that was actually clicked — a tool call inside the Turn. The comment on the
second write predicted the anchor undoing it, since a focus request carries no
gesture. It never did: measured over four clicks the anchor stood down 93 times
and the register refused nothing, and the two item aims drifted 0px. The drift
was on the *first* write. The Turn navigation settled 178px and 334.7px from
where it had put itself, because the item aim arrived 41ms — three frames —
later, and `nextFramePx` equalled the Turn placement both times, so the reader
watched the transcript land and then move. The aim now goes through
`focusFlowItem` on the list, which is a register write, and is attempted in the
same task as the Turn navigation so that only the final position is painted.
When the item is not rendered yet the retry loop still runs, and the Turn
placement is what is on screen until it lands — that part is unavoidable.

**The sticky Task indicator had never run at all.** Its selector wanted
`.flowchat-flow-item[data-flow-item-id][data-tool-name]` on one element, and
`data-tool-name` has only ever been on the tool card *inside* that wrapper —
added two months later, by a commit adding e2e locators, for an unrelated
reason. So its probe could not have fired either, which is why there was no
evidence rather than no problem. Deleted; if the affordance is wanted again it
needs registering as well as fixing.

`traceViewportPlacement` stays for the next writer that has to sit outside the
register, and for what it proved here: read against the register's writes, it
answers *which of two placements won* as readily as *who undid one*.

Everything here can fire on every frame, so repeated identical events collapse
into one entry per 500ms carrying the count and travel it stands for. The key
includes whatever makes one run a different run — the owner, the outcome, the
direction — so a *transition* always emits immediately. A thousand copies of a
steady state would only bury the transitions, which are the point.

**A duration is reported once, when it ends.** Coalescing is what makes the
per-frame traces readable, and it is also why they cannot answer "how long did
that last": only the first of a run is emitted, and the rest are a count.
`anchor.turnReturned` and `anchor.waitAbandoned` therefore report the whole of a
wait for the anchored Turn — milliseconds, settle frames, restore attempts, and
the reader travel carried through it — at the one moment the whole of it exists.
That wait is what decides whether a junction is seen, so it is the number to
read first. These are the only traces here that go through `traceViewport`
rather than the coalescer, because they fire once per wait and their payload is
the point rather than a sample of it.

**Read the state out before the state changes.** A `data` callback is evaluated
by `flowChatDiagnostics.trace`, synchronously, so a thunk over refs is normally
exactly right. It is not right when the caller resets those refs on the next
line, and the wait report does: it takes its numbers eagerly and closes over
them.

**Two numbers say whether a correction was a mistake.** `scrollRangePx` is
recorded on `prependCompensated` and on every `anchor.correct`, because a
correction and the reason for one read the same otherwise. Measured over five
junctions, the correction equalled the change in the scroll range every time
(−94/−93.4, +76/+76.5, +26/+30.7, +8/+7.6): the compensation had not over-shot,
the transcript above the reader had re-measured, and the anchor was following
it. A correction with the range *unchanged* would be the other diagnosis.

Nothing evaluates a payload while the switch is off.

### Reading the log

```text
pnpm run flowchat:log:analyze -- <path-to-flowchat.log> [--around <sequence>]
```

`scripts/diagnostics/analyze-flowchat-log.mjs` reports, in this order:

1. **Episodes** of viewport activity, worst *churn* first — travel per pixel of
   progress. A clean move is 1; a much larger number distinguishes "it moved
   wrongly" from "two writers fought".
2. **Placements that did not stick**, ranked by drift. A placement with no
   outcome sampled is listed separately rather than counted as clean.
3. **Refusals**, as owner × who outranked them.
4. **Declines**, as writer × reason.

Two things it is careful about, because both would otherwise flatter the
result: a coalesced entry is weighed by the run it stands for, not as one event;
and dropped entries are reported at the top, since every count below one is a
lower bound.

The paging side of the same fault is traced separately; see *Diagnosing History
Paging* in `FLOWCHAT_HISTORY_PAGING.md`.

## Related Files

- `flowChatViewportOwnership.ts`
- `useFlowChatViewportOwner.ts`
- `@/infrastructure/diagnostics/flowChatViewportDiagnostics.ts`
- `VirtualMessageList.tsx`
- `useFlowChatNavigation.ts`
- `scripts/diagnostics/analyze-flowchat-log.mjs`
