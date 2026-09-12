# FlowChat Viewport Verification

The automated checks, and the manual ones agents may not run.

## Automated

```text
pnpm run type-check:web
pnpm --dir src/web-ui run lint
pnpm --dir src/web-ui run test:run <the files below that your change touches>
```

Pick by what you changed rather than running the whole column — but this is the
whole column, and it is the only list. Two divergent copies of it used to exist,
each missing what the other had.

| Test | Contract it holds |
|---|---|
| `UserMessageItem.test.tsx` | sent and reloaded MCP references, mixed reference capsules, failed-message presentation, and message actions |
| `modelRoundItemMemo.test.ts` | settled rows refresh continuation labels and tool grouping hints without invalidating equivalent hints |
| `flowChatTailFollow.test.ts` | the three-quarter reservation and `hold-tail` geometry |
| `flowChatCollapseMotion.test.ts` | collapse does not move earlier content |
| `useFlowChatFollowOutput.test.tsx` | one-shot new-Turn reveal, frame loop, blank crossing, resize realign |
| `../../tool-cards/useToolCardHeightContract.test.tsx` | tool cards reflow rather than compensate |
| `flowChatHistoryBoundary.test.ts` | the screenful lead, and the latch's own predicate |
| `flowChatLiveTailWindow.test.ts` | "does the transcript still reach the newest Turn" |
| `flowChatViewportAnchor.test.ts` | anchor geometry and the DOM contract |
| `useFlowChatViewportAnchor.test.tsx` | capture, restore, carry, the settle window |
| `VirtualMessageList.session-boundary.test.tsx` | prepend compensation, the ask, navigation-target current Turn with gesture/follow/session handoff, and search placement only outside the readable viewport |
| `ModernFlowChatContainer.history-state.test.tsx` | history presentation and the submission event |
| `flowChatViewportOwnership.test.ts` | the priority order, preemption, expiry |
| `../../../infrastructure/diagnostics/flowChatViewportDiagnostics.test.ts` | coalescing, placement sampling, the switch |
| `useFlowChatVirtualizer.test.ts` | the offsets-and-positions boundary |
| `useFlowChatVirtualizer.measurement.test.tsx` | `measureRenderedItems` against a real virtualizer |
| `useFlowChatVirtualizer.aim.test.tsx` | the re-aim, and giving it up on takeover |
| `VirtualMessageList.layout.test.ts` | the item-height estimate and the spacer |
| `FlowChatTurnRail.test.tsx` | single-marker emphasis, neighboring hover fan, independent keyboard focus, reduced motion, and rail navigation |
| `useFlowChatSearch.test.ts` | exact matching-block decoration, occurrence counting, and search navigation state |
| `flowChatSearchDom.test.ts` | concrete text ranges and independent highlight ownership across rows and panes |
| `flowChatSearchPresentation.test.ts` | visible source highlighting and single-line marker geometry, wrapping, scrolling, and clipping |
| `FlowChatHeader.test.tsx` | shared SearchField composition, result controls, input identity while expanding, native-view occlusion declaration for session overview, and the default active-only Agent tree toggle |
| `SessionTreePopover.test.tsx` | Agent selection/cancellation/deletion menus, type-only metadata, active branch filtering with ancestor retention, restoring all agents, and the active empty state |
| `../../services/deleteSessionTreeBranch.test.ts` | Unloaded descendant deletion in child-first order, remote location forwarding, failure retention, and device surface guards |

## Manual

**Agents must not perform UI interaction verification.** Report these as pending
unless a human confirms them. They are grouped so that adding a check to one
group does not renumber the others.

### Opening a session

1. Session open lands at the end of the transcript, not inside the spacer.
2. Open a long `isPartial` session and leave it alone. Nothing may page in
   behind the reveal: the transcript opens on its loaded tail and stays there.
   Five pages arriving over 890ms is what this checks for, and the reveal only
   hides the first frame of it.
3. Open a long session and check the scrollbar thumb: its size should be close
   to right on the first painted frame, and it should not jump as items
   measure. This is the per-item estimate doing its job, and it is the single
   most visible symptom if the estimate ever regresses.
4. Session switching and history paging do not restore stale footer height.
5. Scroll up in session A, switch to session B, then return to A. The same Turn
   must remain at the same viewport offset, both in the ordinary tail projection
   and after navigating into an explicit history window.
6. From that reading position, switch to Settings and back. The session scene
   remains mounted with usable geometry while inactive, and the viewport must
   not enter host suspension or move to the tail.

### Submitting and revealing

1. A newly submitted Turn performs one physical-bottom placement, exposing the
   full resident spacer while leaving at least one quarter of the transcript
   visible above the input footer.
2. Send a one-line message and leave the short response alone. The viewport must
   remain at that reveal position; no frame loop may creep toward the content end.
3. While the answer grows but has not filled the blank, history stays visually
   fixed and the blank shrinks. When output reaches the viewport bottom, follow
   starts without a snap and subsequent growth follows normally.
4. Send a message from the live tail, and again while parked deep in history.
   Both must reveal the new live tail; the second also has to
   leave the history window to get there.
5. Send a message, let it reveal, then roll it back from its own message actions.
   The transcript must come to rest with the surviving last Turn at the
   *content end*, not at the old reveal position.
6. Roll a Turn back from further up a transcript, having scrolled to reach it.
   The surviving last Turn must end at the bottom here too — scrolling to reach
   the button hands the viewport to the reader, and the answer has to run
   anyway. Leaving it to the anchor is what showed Turns 2..6 of an 8-Turn
   session with the new last Turn's answer below the fold.
7. Edit a message and rerun it. There must be one movement, not two — the
   truncation is silent and the rerun's Turn reveals as usual.

### Streaming and follow

1. A new-Turn reveal stays fixed until output consumes its blank, then hands off
   to ordinary tail following.
2. With output streaming, scroll up and hold still. Follow must not write while
   the gesture is recent, and must resume once it goes quiet.
3. Jump to latest from a screen or two up is animated rather than an instant
   jump. It must glide the whole way, with at most a small catch-up for content
   that arrived while it travelled — a stand-down counted in frames rather than
   milliseconds used to cut this short.
4. Jump to latest from the top of a long transcript lands outright. Half an
   animation followed by a jump is the failure to look for, and it is what the
   distance cap exists to prevent; `followOutput.jumpBehavior` says which of the
   two was chosen and how many viewports away the target was.
5. While reading a history window, let output arrive from somewhere else. The
   viewport must not move — this is the case the submission event exists to
   stay out of.
6. Watch a Markdown answer stream past the bottom of the viewport. It must
   scroll rather than step: no move of a whole line, and none of the ease's
   lag left behind once the stream stops.
7. Stream a burst — a code fence or a table arriving at once — and confirm it
   goes the whole way in one move rather than gliding through content nobody
   has seen, and that the jump-to-latest bar does not flash while it does.
8. Turn on `prefers-reduced-motion` and stream again. The follow must step
   straight to its target, as it did before the ease.

### Collapse

1. An auto-collapsing TodoWrite or ExecCommand card leaves earlier content
   visually still.
2. Expand and collapse a tall tool card near the top of the viewport, and one
   below it, and confirm earlier content stays put in both cases.

### The user-controlled reserved blank

1. Scrolling down into the reserved blank and letting go leaves the viewport at
   the user's chosen offset; it must not return automatically.
2. Pressing End scrolls to the bottom of the scroll range and stays there until
   an explicit follow action occurs.
3. Scroll to the very bottom and confirm the transcript ends where content
   ends, with the reserved blank below it reachable but not where the session
   opens.
4. Wheel down into the reserved blank and stop. The transcript must remain
   still and the jump-to-latest affordance must stay available.
5. Trigger the delayed jump-to-latest that accompanies live-tail restoration
   while a short Turn reveal is active. It must be a no-op and must not replace
   the reveal with a content-end scroll.

### Output catching up with a reader in the blank

1. Send a message so its one-shot reveal has blank below it, then wheel up a
   little — far enough to leave the tail, not far enough to push the blank off
   screen — and take your hand off. As the answer grows past the bottom edge the
   transcript must resume following, easing rather than snapping, and the
   jump-to-latest affordance must disappear with it.
2. The same scroll, but keep wheeling. The transcript must not take the viewport
   back mid-gesture, and once you are above the end of content it must leave you
   there however much more arrives — until you go back down yourself.
3. Scroll up past the end of content, stop, and let output arrive. Nothing may
   move. This is the case the rule must never claim.
4. From there — above the end of content, follow long gone — scroll back *down*
   until the blank shows again and stop. Follow must resume as output reaches
   the bottom edge. Repeat it a third time. Nothing about this is once-only.
5. With no blank on screen at all — a transcript that fills the viewport, mid
   answer — scroll up a little. Follow must not resume until you bring the blank
   back on screen; nothing was crossed.

### The scrollbar

1. Drag the scrollbar to the very bottom. The screen must not be entirely
   blank: the last Turn and the input clearance stay visible above the
   reservation. Repeat with the composer expanded, which consumes the spacer
   before the three-quarter cap can be exceeded.
2. Drag the scrollbar, without touching the wheel first, down into the reserved
   blank and let go: it must stay there. Then drag it while output streams: the
   transcript must follow the thumb without the frame loop fighting it. A press
   on the thumb that moves nothing must leave the viewport alone.

### Resizing

1. With the viewport resting at the end but *not* following — scroll away and
   back, and check the jump-to-latest affordance is hidden — resizing the
   window keeps content against the bottom in every direction: taller reveals
   more history above, shorter does not cut the last lines off, and narrower
   does not push them off screen as the text rewraps. Repeat while reading
   history: nothing should move.

### History paging

1. Open a session long enough to be `isPartial` — the loaded tail is shorter
   than the viewport, so it pages older Turns in on its own. No jump-to-latest
   bar should appear, and streaming output should be followed. Then send a
   message: it must appear immediately in the one-shot tail reveal, with the
   history above neither moving nor reloading.
2. Scroll up to a junction. **One** page loads, the Turn under the cursor stays
   where it is, and paging stops until the head is reached again. Then keep
   going: every junction must behave the same way all the way to the first
   Turn, with no run of pages and no point where scrolling up stops doing
   anything.
3. Open a long `isPartial` session and scroll up slowly through several paging
   junctions. The Turn under the cursor must not move — not backwards, not
   forwards, and not for a single frame. A stall while a page is measured is a
   known gap and reads differently from a jump: the picture freezes and
   resumes in place, rather than showing different content and snapping back.
   Then scroll up fast through the same junctions, which is where the anchor
   and the user's gesture are most likely to disagree.
4. During that scroll, check that a paging junction does not leave the viewport
   stuck: keep scrolling past it, then wheel back down, and confirm the
   transcript still tracks the gesture in both directions. Nothing on screen may
   fade or slide as rows come back — a row entering the rendered window is not
   its content arriving.
5. Navigate to the first Turn of a long session, then jump to latest. The tail
   window it lands on can be short enough to fit inside the viewport, which
   puts the whole scroll range inside the reserved blank. Scroll up from there:
   history must load. This is the case where the reader is at the top, so the
   wheel emits no scroll event and the gesture is the only thing to go on.
6. In an `isPartial` session that paged on open and is now streaming, scroll
   down into the reserved blank and use jump-to-latest to return. No history
   status may appear at either end of the transcript — the transcript already
   reaches the newest Turn, so there is nothing past its bottom to load. This
   is the case that showed "preparing the conversation history" under a
   complete transcript, permanently, and survived cancelling the Turn.

### Session search

1. In light and dark themes, focus the search field and enter a query. The
   border stays quiet and neutral; the complete result panel has one frosted
   surface. Reduced transparency and high contrast use the opaque fallback.
2. Search for a single letter. Only the current line receives a neutral tint
   and a short marker in the switch's activated color. Other hits retain word
   highlights, and unrelated content receives no search border or background.
3. Advance and go back between two hits on the same readable line. The
   transcript stays still. A hit in an edge fade or behind the composer moves
   into the readable viewport; an unmounted hit remains reachable. Scroll by
   hand while a distant hit is resolving and confirm search stops positioning.

### Turn navigation

At rest the rail's dark emphasis belongs only to its current step
(`aria-current`), not to every Turn visible in the transcript. Hover temporarily
emphasizes just the pointed marker, with a symmetric fan of muted neighbors;
it never changes `aria-current`. Leaving restores the current-step emphasis.
Keyboard focus has its own outline and does not navigate until activation.

1. Turn Rail and Usage Report navigation can top-align the final Turns.
2. Click the last Turn on the Turn Rail while it is short. It must land in one
   movement at the end of the transcript — no top-align followed by a slide
   back down. Do it from near the tail *and* from the top of a long session:
   those are the rendered and unrendered branches, and they take different
   paths. Then click a final Turn whose answer is longer than the viewport: it
   must still top-align.
3. Navigate to a Turn from the Turn Rail — a near one, a far one, and one close
   enough to the end that the window loaded for it reaches the newest Turn. All
   three must come to rest on that Turn at the viewport top and stay there.
4. Navigate to a far Turn and start scrolling with the wheel before it comes to
   rest. The gesture wins immediately and nothing pulls the viewport back to
   the Turn afterwards, including several seconds later.
5. From the Session Usage report, click a tool call and a slow span. Each must
   come to rest with that item centred, in **one** movement — no landing on the
   Turn followed by a slide onto the item a few frames later.
6. **While a Turn is streaming**, click a Turn well up the history. It must land
   on that Turn and stay there — not drift back to where you were reading half a
   second later, which is when the navigation's hold lapses. Then click the same
   Turn again from where you land: the second and later clicks used to fail
   where the first appeared to work.
7. While a Turn is streaming, scroll up with the wheel and let it stop. The
   viewport stays where the gesture left it. Repeat several times in a row and
   keep going after streaming ends: the failure was a scroll that came to rest
   and was then returned, in full, to where that gesture had started.
8. Scroll **down** through a long answer in several flicks, in a session with
   enough history to keep re-measuring. Each flick keeps its distance — the
   failure was arriving and then sliding back part of the way, every time, so
   that a given point in the transcript could not be passed at all.
9. With several short Turns visible together, only the current Turn's rail marker
   is dark at rest. Hover a different marker: it becomes the only dark line and
   longest line, with three progressively shorter muted neighbors on each side.
   Leaving restores the current marker; hovering must not navigate. Repeat at
   both ends of the rail and after scrolling a long rail. Keyboard focus must
   remain visible without changing the current Turn before activation.
10. Click each of several short tail Turns in sequence, including two that land
    at the same content-end offset. Only the clicked Turn is dark, even when an
    earlier Turn remains visible. Repeat with a top-aligned Turn and a sliver of
    the preceding Turn above it. Scroll manually afterwards: current must follow
    the reading position again. Jump to latest and switch sessions to confirm
    neither retains the old navigation selection.
11. With reduced motion enabled, the hover fan changes without animation. Touch
    navigation must not leave a hover fan behind.
