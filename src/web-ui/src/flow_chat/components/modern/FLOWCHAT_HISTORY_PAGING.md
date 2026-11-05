# FlowChat History Paging

## History loading presentation

`HistorySessionLoadingBoundary` covers open intents, cold hydration and bookmark
restoration with one content-independent composition: seven 24px lines, a rounded
user bubble and a shared light field. Session loading indicators appear after
200 ms, including reduced-motion mode and new-session creation. A complete,
settled read inside that interval becomes visible immediately. Warm session
switches also display their settled content immediately. The boundary retains
the loading surface until the existing initial-content gate and
`data-open-viewport-settled` both release.
Only then does it read the rendered window once to align the decorative lines
horizontally. Their height stays fixed; the measured rows are never animated,
re-keyed or scrolled by this boundary.

All abstract marks finish fading before the transcript's outer paint layer
reveals. Its presentation callback releases the existing two-paint barrier for
background history reads, so measurable but still hidden text does not
count as a painted conversation. Interaction and focus stay guarded through
that handoff. Session and surface-activation identity changes cancel old work;
failures, inactive scenes,
reduced motion and hidden documents settle without retaining an animation.
Ordinary streaming and virtual-window remounts do not replay the transition.
This is shared Web UI presentation and adds no persistence or transport shape.
The old `historyOpenIntentSpinner` appearance part remains a hidden compatibility
slot so installed appearance packages still validate; the new visual is exposed
through `historySkeleton`.

## Last-Turn opening

Ordinary local and SSH restore requests ask for one Turn. The peer subscriber
negotiates the same scope through the optional single-Turn snapshot protocol.
The first presentation depends only on that Turn, never on filling an event page
with older Turns. Bookmark restoration and explicit navigation still resolve
their requested range before presentation.

Local hover, pointer-down and workspace-switch prewarming retains the complete
last Turn in an inactive session. Opening reuses that read, including while it is in flight.
The speculative result can commit only while the session remains historical and
its content, workspace and device activation still match. It leaves legacy
full-history completion deferred until selection and visible presentation.

After visible presentation, local/SSH views may warm the preceding range in the
existing window cache without replacing the rendered tail. Peer views may read
one preceding complete Turn and add it above the native tail reservation. Further
history follows reader demand; switching back to a partial, catalog-backed local
or peer session does not trigger full-history completion. Legacy local hosts
without window catalogs retain their full-history fallback.

The native CSS shell below supplies the same opening layout at every content
length: short last Turns start at the top with trailing blank space, long ones
show their end, and older history stays above the reserved shell. Do not fill a
short first screen with older history or classify Turns using measured heights.
Source-read, hydrate and first-content-paint trace phases distinguish transport
wait from presentation wait; fixture timings are not live-device performance.

## Inactive history residency

Reader bookmarks retain the semantic snapshot, intent and ordinal range, never
the Turn bodies. A mounted primary, BTW or subagent transcript holds a history
lease. The store accounts the union of canonical and paged Turns, which can alias
the same objects, in the shared reconstructable-resource budget. Derived caches
are reclaimed before inactive history when that budget is exceeded.

Unleased local history can return to metadata-only under resource-budget pressure,
only when its Turns are unchanged persisted-read objects. Idle time alone does
not evict history; keep the warm path when resources fit the budget. Selection,
hydration, in-flight reads, runtime interactions and live or unsaved projections
prevent eviction. Relay replicas and dispatch observers keep their existing
owners. Drafts, catalogs, permission mailboxes and runtime state are outside this
cache lifecycle.

On return, a bookmark resolves through the store's existing range reader before
the transcript paints. The viewport owner restores its semantic anchor; a cold
read never navigates to the tail as a fallback. Session, surface and navigation
generation fence the result. Failures expose retry, while stale reads may warm
the cache without replacing a newer reader intent.

## Complete Turns are the history publication unit

A history transport packet is not a render transaction. A negotiated single-Turn
snapshot carries its identity, total record count, packet offset, older-Turn
boundary and live cursor. The Rust subscriber validates and joins its packets
before emitting records followed by ready. It continues live catch-up during an
older read; historical revisions cannot overwrite newer live revisions.

Hosts without the optional acknowledgement retain bounded record paging. The
controller joins pages until each root's optional `turnRecordIds` membership is
present, including unchanged items older than a republished terminal root. Missing
members, a stalled cursor or an epoch change fail without publishing fragments.
Hosts without membership evidence finish the available history before publication;
their first open can take longer. None of these fields changes persisted Turns.

`RelaySessionHistory` stages annotated replay records outside the replica until ready.
There is no 250ms history flush: timers, document visibility, immediate terminal
records, mailbox reads and direct runtime flushes cannot expose half a Turn.
Live updates, including during older reads, retain frame batching and immediate terminal
settling. Already published history survives a failed read; retry replays the
unpublished batch. Local restore/window APIs already return whole Turn bodies.

## Native history origin

Historical viewing uses a native bottom scroll origin. The scroller is a
`column-reverse` flex container with one non-shrinking extent; rows inside that
extent remain in chronological DOM order. The latest complete Turn has a CSS
minimum extent of one viewport minus the header gap, with flexible trailing
space after its content. A short Turn therefore starts at the top; older Turns
insert outside that reservation. No content-height estimate determines its
position. Native `scrollTop` is zero at the latest content and
negative toward earlier content.

Earlier complete Turns extend the extent upward. Partial historical Turns never
enter the rendered projection. Neither the old first item's
estimated height nor the total height difference determines the viewport.
`FlowChatPrependSnapshot`, leading-extent floors and passive follow corrections
are disabled for this layout. The container's repeated `scrollToTurnEnd` opening
request only acknowledges a rendered latest row; it cannot re-aim the native
history tail when the Turn-summary count changes. Delayed card measurements and width reflow above
the visible tail do not need scroll writes or animation.

The virtualizer traverses this layout from newest to oldest. An older prepend
appends to that internal sequence, leaving the tail's coordinates unchanged.
Height estimates reserve unmounted rows for range selection; they never decide
how far to move the historical tail. The adapter translates back to chronological
indexes for renderers, selection, navigation and pagination. See
`FLOWCHAT_VIRTUALIZATION.md` for measurement and index details.

Layout lifetime is separate from hydration. `Session.isHistorical` becomes false
when the first page is ready, so it cannot select the coordinate convention.
An idle transcript opens in native history layout and keeps it through all
background pages. Actual runtime processing or explicit submission hands it to
the live layout. Explicit history-reading mode selects native history layout.
`FlowChatScrollOriginBoundary` preserves an existing painted row during that
coordinate handoff and publishes the new offset before window selection.
A page arriving in the same layout never enters this transaction.

The reading anchor still preserves a reader-selected, actually mounted block
when content below it changes. It measures that block's screen relationship,
not unseen prefix heights. The anchor and reader-demand accounting use native
scroll travel: increasing the history range is not a user scroll. A wheel at a
short transcript's stationary tail asks for earlier content without selecting
a stationary user bubble as an anchor. New older content continues upward.

Navigation and persisted snapshots retain their existing top-origin convention.
`flowChatScrollCoordinates.ts` converts those offsets at the viewport adapter.
Old bookmarks remain readable; no stored field or remote protocol changes.

## A page is asked for a screenful early

`HISTORY_BOUNDARY_LEAD_SCREENS` requests a page while its boundary is within a
viewport of the reader, with the existing item-boundary fallback for short
transcripts. The lead is a proximity signal; the pager still owns permission,
request tickets, commit acknowledgement and fresh directional reader demand.
Do not use overscan rows as a visible range, or infer user travel from a growing
native history range.

## Request, Layout, and Reader Demand

The former implementation kept separate `armed`, `reached`, `pending`, and
`exhausted` refs. A September 22 reproduction showed a successful first page,
then a `tail -> 38:46` window change clearing `reached` while retaining
`armed=false`. The prepend snapshot matched and compensation succeeded, but the
first off-head observation was now false -> false. Re-arming required true ->
false, so a second visit to the head was refused indefinitely. A prefetch that
never reached the physical boundary had the same structural weakness.

`flowChatHistoryPager.ts` now owns a state machine per direction:

- `ready`: an initial ask is available once opening/follow ownership permits it.
- `requesting`: one ticket owns the asynchronous request; further reader demand
  is coalesced into a boolean, never a queue of wheel events.
- `awaiting-layout`: an applied result has arrived, but its presentation commit
  has not yet been acknowledged.
- `waiting-for-reader`: result and layout have both arrived; fresh demand can
  dispatch another page while the boundary is within the lead.
- `exhausted`: no more content at the window/boundary that answered.

The list reserves a ticket before invoking the handler. Its existing
`prepareViewportForPresentationCommit` callback checks that the ticket is still
current. A layout effect **after** measurement, window reconciliation, and
prepared navigation acknowledges the presentation. Layout can precede or follow
the promise result. A completion acknowledgement also renders when the returned
page was already projected. This acknowledges a commit, not convergence of all
future row measurements; later measurement callbacks cannot create reader demand.

Directional wheel/touch/key intent can ask even at scrollTop=0, where no native
scroll event occurs. Native travel covers scrollbar dragging and inertia. The
viewport register subtracts its actual synchronous writes/shifts (including
clamping), so a delayed scroll event caused by a registered repair adds no demand.
Owned smooth navigation/follow scrolls are excluded. Content commits rebaseline
travel because replacing content can clamp the browser's scroll position.

Demand accumulated during a fetch survives until the new layout is evaluated.
If the new boundary lies outside the lead, or the reader reverses direction, it
is discarded. Repeated rendering, measurement, and correction never manufacture
another page. A new gesture or travel toward the boundary can ask again without
requiring the reader to first hit, leave, and revisit the physical edge.

Navigation invalidates request tickets. An old result cannot clear a newer
request or attach exhaustion to a different window. Non-applied outcomes leave
no pending ticket; errors/cancellation require a new reader action rather than
a render-driven retry loop. Exhaustion is forgotten when its window/boundary
changes. Session instances isolate the controller across session switches.

Opening and follow-output guards remain synchronous (`isFollowingOutputNow`),
so the gesture that releases follow is evaluated against the new owner. Geometry
with no visible range remains a diagnostic refusal. Request/refusal diagnostics
report the phase and request identity without transcript content.

Automated tests cover event ordering, consecutive real prepends, queued intent,
passive layout repetition, stale completions, failed requests and registered
scroll travel. The user confirmed that the original second-page failure was
resolved in the September 22 reproduction. The broader input-device matrix and
remote transports still require separate manual validation; unit geometry is
not performance evidence.

## Reading continuity and live-layout compatibility

Native historical tail loading has no prepend compensation pass. Its earlier
content grows above the fixed native origin, including delayed measurements.
When the reader scrolls into history, the existing DOM anchor tracks the actual
visible block. Structural changes below that block preserve its screen offset
through `TimelineMutationBoundary` and the viewport register. Publish accepted
reader repairs to the virtualizer immediately; waiting for a native scroll event
can select an intermediate window that removes and recreates the same row.

The live layout retains its top-origin leading extent, prepend snapshot and
follow rules. Those apply to an active reply and its reserved trailing space,
not to the default historical open. A history-to-live handoff preserves current
DOM identity; a submitted message then performs its existing one-shot placement.
The virtualizer refreshes its measurement-index attributes at that handoff so
later ResizeObserver entries cannot resize the old index.

`VirtualMessageList.timeline-prepend.test.tsx` exercises the production timeline
with real virtualization, ownership and follow hooks. It covers complete-Turn publication, structural edits above a reader, short text
and tool histories, consecutive pages, delayed sizes,
width-independent origin lifetime, navigation, existing bookmark shapes and live
handoff on local and simulated Peer surfaces. Native-history tail assertions
require the same DOM node and screen position before observer callbacks, and
zero scroll writes through the page/measurement sequence. Geometry is supplied
because jsdom has no layout engine; these are not native WebView or live remote
verification results.

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

When the exact row has not entered the rendered window, restoration measures
the mounted rows, resolves the saved key in the current virtualizer, and uses
its current bounds plus the saved intra-row offset to materialize it. That first
placement stays within the estimated row when the saved offset exceeds the
estimate; otherwise a long answer could remain outside the mounted window. It then
publishes the actual offset back to window selection without waiting for a
native scroll event. Repeatedly using the old absolute `scrollTop` can select a
different Turn indefinitely because a remount starts with a new measurement
cache. The saved absolute offset remains a compatibility fallback when the key
cannot be resolved. Once the row exists in the DOM, its semantic offset is
authoritative. A snapshot
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
intermittent, so refusal warnings include a bounded recent-event trail.

`historySessionDiagnostics` keeps a per-session ring buffer shared with the
hydration timeline. `warnHistoryPagingRefusedWithPendingTurns` writes the refusal
and its recent events through `log.warn` once per session, so scrolling against
a dead boundary cannot flood the log. The opt-in `flowchat.log` step stream has
been removed; `app.logging.flow_chat_diagnostics` remains in configuration.

The container raises this warning for an inconsistent `beyond-known-total`
answer or a declined viewport preparation. The former session-wide
`latched-exhausted-while-partial` detector in the list has been replaced by the
pager's window-scoped exhaustion and request phases. A partial live
tail alone does not prove that a particular rendered history boundary has more
content.

When the report is "scrolling up shows no history, but the Turn Rail can still
load those Turns", search the log for `declined to page older Turns`. Turn Rail
navigation goes through `loadSessionTurnWindow` directly and bypasses the
viewport paging controller, which is why it keeps working. The accompanying
`FlowChat history paging trail` warning carries the preceding events, including
`anchor_capture_failed` — `captureHistoryPrependAnchor` returning `false`
cancels a window that was already fetched.

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
