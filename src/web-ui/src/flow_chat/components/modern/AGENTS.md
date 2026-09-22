# FlowChat Scroll Instructions

This file applies to the modern FlowChat viewport implementation under this
directory. It is the rules. The reasoning, the measurements, and the failures
each rule was written against live in the documents below — read the one that
covers what you are about to change.

Also follow the repository and Web UI instructions in the parent guides.

## Required Reading

| Changing | Read |
|---|---|
| the tail spacer, the follow target, new-Turn revealing, holding, resizing, the footer | `FLOWCHAT_SCROLL_STABILITY.md` |
| history paging, the prepend, the viewport anchor, history presentation | `FLOWCHAT_HISTORY_PAGING.md` |
| anything that writes `scrollTop`, one-shot navigation, the diagnostic trail | `FLOWCHAT_VIEWPORT_REGISTER.md` |
| the virtualizer, item measurement, item keys, anything a row renders | `FLOWCHAT_VIRTUALIZATION.md` |

`FLOWCHAT_SCROLL_STABILITY.md` also carries *Known Gaps* for all four — check it
before reporting a defect as new.

## Reservation and Follow

- FlowChat caps the input footer plus resident tail spacer at three quarters of
  `scroller.clientHeight`; the spacer also depends on the current footer inset.
- Static reservation is allowed; reactive compensation is not. Do not derive any
  reserved height from a measured content height, a collapse delta, an animation
  duration, or a streaming rate.
- Do not add sticky Turn modes, pre-collapse compensation, or persistent
  element-anchor guards.
- The follow target lives in `flowChatTailFollow.ts` as pure functions over
  geometry. Keep it free of timers and mutation observers.
- `scheduleFollowToLatest` must not force the content end — the hold rule is
  what keeps a collapse from moving the viewport. During `revealing-tail` it
  samples the blank crossing and performs no viewport write.
- A new Turn gets one physical-bottom placement after it enters the live-tail
  projection. Streaming consumes the exposed spacer at fixed `scrollTop`, then
  hands off to `hold-tail` when the blank closes.
- `useFlowChatFollowOutput` is the only continuous outer viewport writer.
- The follow's **write** may be eased; its **target** may not. Everything that
  reads the follow — the settle budget and the at-tail band — reads
  the offset the rule owns, never how far behind the ease is riding. The ease
  stands down while the transcript is opening, where the target is
  authoritative.
- A follow the frame loop is still correcting counts as being at the tail.
  Ownership cannot stand in for that: it outlives the loop, which is exactly the
  state a viewport stranded in the reserved blank is in.
- The loop's stand-down for its own animated scroll is timed in milliseconds at
  both ends — how long it waits for the animation to move, and how long it
  waits for the animation at all. Neither may be a frame count: a frame count
  is not a duration, and a smooth scroll eases in slowly enough that its first
  frames do not move at all on a high-refresh display.
- A jump to latest animates only within `FLOWCHAT_ANIMATED_JUMP_MAX_VIEWPORTS`
  and lands outright past it. Measured in viewports, never in pixels: the
  question is whether the reader can follow the movement, and what they can
  follow is a share of what they can see.
- Scrolling up loses the follow only once the reader is past the end of real
  content. Until then they are in the reserved blank, having missed nothing, and
  output growing to fill it hands the viewport back — unless their own gesture
  claim is still live, in which case the crossing is deferred, not spent. Judged
  by which side moved further between two samples, never by geometry alone.
- That watch runs for as long as the reader holds the viewport, not for one
  crossing. A reader may climb out of the blank and scroll back down into it any
  number of times, and each time is another chance for output to reach them.
- Footer height represents only the current input-stack layout and real footer
  content such as history state and `RuntimeStatusSlot`. The tail spacer is a
  separate sibling and must not be folded into it.
- "At bottom" is measured against the end of real content, which sits above the
  tail spacer, so no alignment to the last item can express it.

## The Viewport Register

- Every deliberate viewport write goes through `useFlowChatViewportOwner`, named
  with the owner it belongs to, and holds that ownership for as long as it is
  moving — an animation included. Never assign `scrollTop` or call `scrollTo`
  on the FlowChat scroller directly.
- Adding an owner means adding it to `FLOWCHAT_VIEWPORT_OWNERS` in priority
  order and to its test, not adding a condition to anyone else's predicate.
- The virtualizer's own writes are registered through its `scrollToFn` option
  and attributed to whoever asked for the aim. Do not bypass it.
- A writer that declines to move the viewport says so through
  `flowChatViewportDiagnostics.ts`. The register records the writes; a write
  that never happened is invisible everywhere else, and "nothing happened" is
  the more common report. Anything reachable every frame goes through
  `traceViewportRepeating`, keyed by what distinguishes one run from another —
  **including the magnitude a reader would feel and the subject it is about**. A
  run collapses to its first sample and turns the rest into a sum, so a key too
  coarse to separate a rounding correction from a 400px one hides exactly the
  events worth having: two rounds of diagnosis in a row read `0.7px` against
  458.7px of suppressed travel spanning three different anchors.
- There are no viewport writes outside the register. Adding one means wrapping
  it in `traceViewportPlacement` and having a reason it cannot be a register
  write; both writers that used to be outside are gone.
- One user action gets one painted placement. A focus request that first
  navigates to a Turn and then aims at an item inside it does both in the same
  task — two placements a few frames apart are two movements the reader sees,
  and the sampled drift lands on the first one, not the second.
- Centring a flow item is `VirtualMessageListRef.focusFlowItem`, not
  `element.scrollIntoView`. The virtualizer aligns *items*, so it cannot express
  "this tool call inside this Turn"; the computed offset is the contract's
  carve-out for a target that is not an item, and it still goes through the
  register.
- One-shot Turn/search/history navigation remains inside `VirtualMessageList`.
- A gesture ends an aim, it does not merely outrank it. The library's re-aim
  runs for 5s and cannot see a refusal, while a gesture's hold lasts 200ms, so
  `notifyUserScrollIntent` calls `cancelAim`. Anything else that hands the
  viewport to a new owner mid-aim owes the same call.

## History Paging and the Anchor

- Deciding *that* a history boundary is worth asking about belongs to
  `flowChatHistoryBoundary.ts` and reads only a visible item range and the
  scroll distance to each end. `flowChatHistoryPager.ts` owns request eligibility;
  the list feeds it reader intent and completed layout commits, and refuses asks
  while opening or follow-output owns the viewport.
- A page asks for what lies past the *rendered* transcript, never past the
  window the store cut. The continuous projection makes those differ, and the
  window's end is then an ordinal already on screen.
- Every path out of a boundary intent records an outcome and leaves the boundary
  status in a state it can be seen in. A silent return is a status the reader
  keeps looking at, and `loading` is not a resting state.
- A boundary status is labelled by what it is. An `error` rendered with the
  `loading` label is a permanent failure shown as permanent progress.
- The ask goes out a screenful before the boundary, so the junction lands off
  screen. Do not express that lead in items: one item here is anything from a
  38px user message to a 5012px model round.
- Request completion and presentation layout are separate events, in either
  order. A page must pass both before another page can dispatch. Notify layout
  only after measurement/prepend compensation; do not use timers as commit proof.
- After the first ask, another page requires fresh directional reader demand.
  Coalesce demand received during a request; clear it when the reader reverses
  or the boundary leaves the prefetch lead. Layout/resize/compensation alone
  must not create demand. Do not require a prefetch to reach the physical edge.
- Bind async outcomes and pre-commit permission to request tickets. Navigation
  invalidates old tickets; an old completion cannot clear or exhaust a new ask.
- Derive native reader travel through the viewport register's accounting for
  synchronous writes/shifts. Exclude owned smooth navigation/follow scrolls;
  unowned inertia still counts. A gesture at the physical edge needs no travel.
- A *visible* item range is `getVisibleItemRange`, never the rendered rows. The
  rendered window carries overscan and reports both ends present for any
  transcript short enough to render whole.
- Boundaries are evaluated on scroll **intent**, not only on `scroll` events. A
  reader already at the top produces no scroll event, so the one signal that
  they want more history is the gesture itself. Evaluate after ownership has
  been released, so the ask is theirs rather than our placement's.
- Ownership is read through `isFollowingOutputNow()`, never a render-time mirror
  of `isFollowingOutput`. A gesture releases it synchronously and asks in the
  same handler; the mirror still reports the ownership that gesture just ended.
- `exhausted` is latched per *window*, not per session. It answers "nothing
  before this start ordinal", so the latch clears whenever the window's ordinals
  change — not only when a page is `applied`.
- A history prepend must be compensated for in `VirtualMessageList`, by the
  height of the items that arrived above. Keying measurements on item identity
  covers the measurements; it does not move the scroll offset. The compensation
  cannot finish the job on its own — most of the movement is the arrived items
  measuring over the frames after it, and only the anchor's relationship
  survives that.
- That compensation and the viewport anchor are displacements, not positions:
  `viewportOwner.shift`, never a write with an owner. A gesture must not be able
  to refuse either — paging up happens only while the reader is scrolling up, so
  anything a gesture can refuse here is refused every time.
- A scroll re-anchors the reader, except while the anchored Turn is missing from
  the rendered window. A correction is owed there and cannot be measured yet, so
  the anchor is carried through the scroll — credited with the reader's own
  travel — never replaced by whatever else happens to be rendered.
- The anchor's settle window is refreshed by what a frame *observed*, never by a
  counter left over from an earlier one. A frame that stood down for another
  owner looked at nothing, so it refreshes nothing — otherwise the loop runs at
  frame rate for as long as that owner rests on the viewport, which at the tail
  is indefinitely.
- The viewport anchor lives in `flowChatViewportAnchor.ts` and
  `useFlowChatViewportAnchor.ts` and must stay independent of the virtualizer:
  it may read the scroller and the Turns rendered inside it, and nothing else.
  Virtualizer-specific compensation stays in `VirtualMessageList`.
- "A new Turn" is `activeSession.dialogTurns.at(-1)`, never the end of the
  projection. Do not qualify that identity by whether the Turn is on screen —
  that belongs to the response, which defers until the Turn can be revealed.
- Detecting one means the ledger **grew**, not that the identity changed. A
  rollback truncates `dialogTurns` and moves that identity backwards onto a Turn
  that was always there; read as an arrival it reveals the survivor as new.
- An action that rewrites `dialogTurns` and wants the viewport moved announces
  it — `FLOWCHAT_MESSAGE_SUBMITTED_EVENT` for giving up a navigated history
  window, `FLOWCHAT_TURNS_ROLLED_BACK_EVENT` for settling on a new tail. The
  ledger cannot tell a Turn the reader sent from one that arrived from
  elsewhere, nor a rollback from a window re-cut, and there are two dozen
  writers of that array. Do not infer either from a count.

## Virtualization and Rendering

- `useFlowChatVirtualizer.ts` is the only module that may import a virtualization
  library. It speaks in scroller offsets and item positions; anything that would
  make a caller aware of which library is underneath belongs inside it.
- Prefer `scrollItemIntoView` over computing an offset. The virtualizer re-aims
  while items below the target measure, and an offset computed once cannot.
  Compute one only when the target is not an item.
- Anything reading an item position in the commit that changed the items calls
  `measureRenderedItems()` first. The library skips its inline measurement while
  the reader is scrolling, which is exactly when history arrives, so the cache
  holds reserved estimates until the ResizeObserver delivers a frame later.
- The virtualizer must not adjust the scroll for its own re-measurements. It
  replays a delta against a scroll position it learns about a frame late, and
  every continuous writer here assigns `scrollTop` directly.
- The virtualizer never follows output.
- No mount-triggered enter animation inside `.virtual-item-wrapper`, no mount-triggered
  motion that changes transcript geometry, and nothing keyed on a state change a
  scroll can replay. A row mounts when it enters the rendered window, not when
  its content arrives, so the animation runs again on every page up and every
  scroll back. Cancel it at the wrapper rather than in the component — this has
  been patched locally four times and recurred each time.
- Explicit submission feedback must consume a short-lived, device-activation,
  Session, Turn, and message-scoped receipt from `submittedMessagePresentation`.
  Only `useSubmittedMessageMotion` may use it for opacity/translation on the
  message contents; never animate the measured wrapper or infer an arrival from
  mount, timestamps, status, or transcript growth. Remounts consume no second
  receipt; reduced motion, focus, and surface changes settle immediately.
- Tool cards reflow naturally and dispatch only `tool-card-toggle` after an
  expanded-state change so the virtualizer can remeasure.
- Stable virtual-item keys and projection identity must be preserved. Do not
  split one `ModelRound` into multiple virtual items or reclassify projection
  from a timer.

## Verification

`FLOWCHAT_VERIFICATION.md` is the single list — the automated checks, mapped to
the contract each one holds, and the manual ones grouped by scenario. Do not
keep a second copy here.

Do not perform UI interaction verification. Report the manual checks as pending
unless the user confirms them.

## Keeping These Documents True

Update the document that owns the area you changed, and this file only if a rule
changed. A rule belongs here when a reviewer could catch its violation by
reading a diff; everything else — the reasoning, the numbers, the failure it was
written against — belongs in the document.
