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
| `flowChatTurnSummaries.test.ts`, `../../utils/flowChatTurnIdentity.test.ts`, `../../utils/flowChatTurnOrdinal.test.ts` | stable summary identity across streamed body updates; append/rollback, catalog and storage-index corrections, partial-tail offsets, catalog-only/empty history windows, provisional usage reports and legacy identity compatibility; batched catalog lookup without per-Turn rescans |
| `../../timeline/useTimelineInteraction.test.tsx` | selection/focus retention and cleanup; mutation/resize bursts coalesce before dimension reads, inactive viewports keep leases without measurement and refresh on reveal, while explicit active selection/focus changes retain immediately; supplied DOM geometry, not native performance evidence |
| `flowItemRhythm.test.ts`, `../../../tools/generative-ui/genUISpacing.test.ts` | mixed agent-card full-row children and exact generated-content gap matching through nested stacks, hidden children and insert/remove snapshots; native invalidation and performance are verified separately |
| `../../store/modernFlowChatStore.test.ts`, `../../grouping/selectors.test.ts`, `../../grouping/activityGrouping.test.ts`, `../../../shared/utils/resourceBudget.test.ts` | cached/full projection equivalence across repeated thinking/tool-parameter streams, interior updates, rollback, completion and legacy retry/recovery; alternating live/history/side projections, completed-row reuse on append, same-store clear/reopen invalidation, warm equal-ID source isolation, group alias restoration and group-position independence; interrupted-prefix and shared-reference byte accounting |
| `useFlowChatVirtualizer.initial-window.test.tsx`, `useFlowChatSearch.test.ts` | delayed observer delivery after live prepend / history tail insertion resizes the surviving key; suspended mounts are observed on resume with or without origin handoff; closing one search releases its match cache without affecting another view |
| `../../perf/longRoundPerfHarness.test.tsx` | deterministic settled-row/block identity reuse, including interleaved history and side projections, plus diagnostic stage timings; supplied DOM fixtures, not native frame-rate or live remote evidence |
| `../../../infrastructure/markdown/markdownSections.test.ts`, `../../timeline/document.test.ts` | exact source reconstruction and equivalent Markdown ASTs across LF/CRLF/CR, lists/fences/tables/quotes/math, conservative reference/HTML fallback, canonical identities, Unicode search counts, bounded section estimates, no live completion repartition, and display-only narrative ID handoff with canonical bookmark/navigation IDs, retry/source isolation and alias-collision recovery; native single-attempt metadata omission and restored blank-line section coordinates without modifying host text; running groups list only in-flight members (serial, parallel, between steps, folded approval) while explicit expansion lists all and settled groups fold |
| `../FlowTextBlock.test.tsx`, `../../../infrastructure/markdown/MarkdownCodeBody.test.tsx` | sealed live-prefix DOM/parser reuse, one shared decoration observer, selected-node retention, source-only oversized fences and cleanup; DOM fixtures, not native paint evidence |
| `../../trajectory` | bounded long-session rail, stable range identities, keyboard preview vs selection, searchable summary pagination, legacy-peer gating, stale device/query rejection, canonical peer body navigation, shared detail components and bounded output; local DOM/transport fixtures, not native rendering or live remote evidence |
| `../FlowChatWidthBoundary.test.tsx`, `../../../infrastructure/appearance/preferences/flowChatWidthStore.test.ts`, `../../../app/scenes/settings/pages/application/FlowChatWidthSettingsSection.test.tsx` | symmetric pointer/keyboard column resizing, token-derived bounds, cancellation/cleanup, narrow-pane restoration, persisted preference compatibility and settings/reset synchronization; supplied DOM geometry, not visual or live remote evidence |
| `../../timeline/hostQueueProjection.test.ts`, `../../timeline/useHostQueueTimeline.test.tsx`, `../HostPendingQueuePanel.test.tsx` | host-accepted preview, canonical handoff/event ordering, stable keys, blocked recovery, old-host fallback, history-window visibility and device lease cleanup; fixtures only, no live remote transport evidence |
| `TurnFooter.test.tsx`, `modelRoundItemMemo.test.ts` | latest-turn identity, hover/focus across virtual rows, lease cleanup, no projection churn and the existing completion reveal gate; behavior only, not visual proof |
| `MessageExportControls.test.tsx` | flat copy/export menu, illustrated checkbox-card selection by pointer and keyboard, complete user text/reference rendering, omission or expansion of thinking, minimal branding, confirmation, pending/error feedback, cancel/Escape/outside dismissal and resident-trigger focus restoration; local DOM behavior, not image fidelity or remote-host validation |
| `exportImageLayout.test.ts` | initiating reading-column width and font settings across wide/narrow panes, hidden sibling sessions, and unmounted source rows; measured DOM fixtures, not native visual or remote-host validation |
| `../../utils/exportImageCapture.test.ts`, `../../utils/captureElementToDownloadsPng.test.tsx` | resolved-style selection without duplicated theme variables, opaque/transparent blank-raster rejection before logo compositing, bounded pixel reads, reduced-scale recovery, font readiness/embedding, timeout cleanup, and widget export save/error handling; rasterizer fixtures, not native WebView or remote-host validation |
| `../../../shared/ui/Tooltip.test.tsx` | shared metric click opening, immediate scroll dismissal, delayed-open cancellation, viewport-exit observer cleanup and no automatic reopening; DOM/observer behavior only, not native scrolling or visual proof |
| `../../utils/turnUsageMetrics.test.ts`, `TurnUsageMetrics.test.tsx`, `../../store/modernFlowChatStore.test.ts`, `../../../features/dispatch/DispatchJobObserver.test.ts` | separate request TTFT, request-to-completion output rate including provider wait and excluding tool execution, complete multi-round timing, controller setup-row exclusion, legacy/missing/zero telemetry, speed boundaries and projection |
| `../../services/flow-chat-manager/EventHandlerModule.test.ts`, `../../services/flow-chat-manager/PersistenceModule.test.ts`, `../../store/FlowChatStore.test.ts` | live cache aggregation, optional-field persistence and legacy/current hydration; no remote-host claim |
| `../../hooks/useSessionReadOnOpen.test.tsx` | opening and foreground results mark read; inactive scenes, background windows, unmounts, and device switches cannot acknowledge from stale views |
| `../../selection/conversationExcerptInventory.test.ts` | source session/device isolation, consumed draft/queue marks, sent-number retention without source marks, stable unrelated snapshots |
| `../../selection/conversationExcerptMarkerPosition.test.ts` | full selection bounds, measured badge groups, persistent upper-right placement over occupied text, and clipping; geometry contracts only, not visual acceptance |
| `../ChatInputAttachments.test.tsx` | shared image/annotation strip, source-marker and attachment-dialog removal, pending editing, read-only sent snapshots with no write controls/shortcuts, one-line source quote, locate, keyboard containment and stale-device rejection |
| `../../selection/conversationExcerptEditing.test.ts` | draft/visible/queue edit and delete ownership, preserved prompt context and attachments, legacy payload handling, sending guards and sent snapshots with no mutation capability |
| `../../services/flow-chat-manager/PendingQueueModule.test.ts` | persisted payload edits preserve queue order/identity, images and device isolation; sending entries reject edits |
| `../../../infrastructure/markdown/useStreamingTextReveal.test.tsx` | appended-glyph-only fading, independent batch clocks and renderers, history/remount stability, stream completion and reduced motion |
| `UserMessageItem.test.tsx`, `userMessagePreview.test.ts` | preview-only layout with complete text/line endings/reference capsules preserved, expansion/collapse and full-message copy, sent and reloaded MCP references, failed-message presentation, shared edit/rollback menu, Escape focus return, disabled reasons, and existing message action flows; local DOM/CSS fixtures, not native width or remote transport evidence |
| `UserMessageItemActions.test.ts` | metadata visibility, bubble outsets from the shared reading column, and normal-flow action layout |
| `../../services/submittedMessagePresentation.test.ts` | explicit-send receipts, one-shot claims, expiry, device activation isolation, and initial status paint delay |
| `useSubmittedMessageMotion.test.tsx` | submission clock, remount stability, StrictMode, reduced motion, focus, and surface-change cancellation; lifecycle only, not visual acceptance |
| `RuntimeStatusSlot.test.tsx` | resident status slot identity and removal of a pending submission paint delay when real status clears |
| `modelRoundItemMemo.test.ts` | settled rows refresh continuation labels and tool grouping hints without invalidating equivalent hints |
| `flowChatTailFollow.test.ts` | the three-quarter reservation and `hold-tail` geometry |
| `flowChatCollapseMotion.test.ts` | collapse does not move earlier content |
| `useFlowChatFollowOutput.test.tsx` | one-shot new-Turn reveal, frame loop, blank crossing, atomic reflow across native clamping, preserved output lag, opening readback publication and ownership/lifecycle gates |
| `../../tool-cards/useToolCardHeightContract.test.tsx` | tool cards reflow rather than compensate |
| `flowChatHistoryBoundary.test.ts` | the screenful lead and physical boundary geometry |
| `flowChatViewportGeometry.test.ts` | actual gutter centring, symmetric/omitted leading gutter and origin handoff without accumulated horizontal offset |
| `../../services/RelaySessionHistory.test.ts`, `../../store/FlowChatStore.test.ts`, `../../services/flow-chat-manager/SessionModule.test.ts` | local/SSH one-Turn restore, paint-gated adjacent prefetch without tail replacement, partial reopen without full-history drain, replay staging, live updates during older reads, failed-read retention and retry; transport fixtures, not live remote evidence |
| `flowChatHistoryPager.test.ts` | request/layout ordering, coalesced demand, prefetch without physical arrival, stale tickets, exhaustion and retry eligibility |
| `useFlowChatViewportOwner.test.tsx` | top/native coordinate conversion, older-range growth creates no reader demand, synchronous write/shift accounting preserves reader travel and actual clamping |
| `flowChatLiveTailWindow.test.ts` | "does the transcript still reach the newest Turn" |
| `flowChatViewportAnchor.test.ts` | anchor geometry and the DOM contract |
| `useFlowChatViewportAnchor.test.tsx` | capture, restore, carry, the settle window |
| `useFlowChatLeadingExtent.test.tsx` | shared event geometry without repeated rectangle reads; fresh layout reads after resize and collection |
| `VirtualMessageList.session-boundary.test.tsx` | prepend compensation, consecutive paging with/without queued input, passive scroll suppression, navigation-target current Turn with gesture/follow/session handoff, search placement only outside the readable viewport, and real viewport-register acknowledgement before trajectory details/highlights commit for user/search/model/folded-tool/history targets |
| `VirtualMessageList.resize.test.tsx` | one viewport ResizeObserver instance kept through streamed flushes on local/simulated peer surfaces; visible rows held still while wheeling into never-measured rows with estimate misses both ways, including scrolls delivered after the gesture window; first-frame node and screen-position retention during repeated CSS-only width previews, release, fractional row geometry, native clamping, both row/container observer orders and delayed scroll delivery; same-size viewport recovery observes suspended mounts without further output, manual re-render or scrolling in live/history layouts; completed follow and reader-owned positions on local/simulated peer surfaces, not native or live-transport evidence |
| `VirtualMessageList.history-prepend.test.tsx` | full list with real virtualization/follow/ownership: stable row identity and screen offset through short/long completed answers, consecutive/dense prepends, delayed measurement/native scroll and reader-chosen positions on local/simulated peer surfaces; supplied row/DOM geometry, not native or live-transport evidence |
| `VirtualMessageList.session-switch.test.tsx`, `useFlowChatVirtualizer.retained-sizes.test.tsx`, `useConversationTimeline.retention.test.tsx` | reopening one of the three most recently left sessions reuses its projection rows and measured row sizes: zero size corrections, fewer commits and row mounts, no dropped rows in the native-history layout, the same settled placement, eviction of older sessions, a single correction for a row that changed while hidden, and no viewport shift when a partly visible retained row grows; supplied DOM geometry on the local surface, not native switching time, paint or remote evidence |
| `VirtualMessageList.timeline-prepend.test.tsx`, `FlowChatPrependSnapshot.test.tsx` | production timeline whole/compound/single-Turn pages; native bottom-origin continuity before observer delivery and zero passive scroll writes, stable hydration lifetime, fractional measurements, bounded long histories, empty-projection navigation, chronological navigation, legacy whole-text and section bookmark coordinates, live handoff and reader-selected block retention; settled host ID replacement retains measured row nodes/positions on every frame and uses canonical bookmarks across reopen; supplied DOM geometry on local/simulated Peer, not native paint or live transport evidence |
| `flowChatScrollbarMask.test.ts`, `VirtualMessageList.session-boundary.test.tsx` | idle gutter masking with symmetric, one-sided and overlay scrollbars; overflow restoration and content/viewport resizing without scroll writes; supplied DOM geometry, not native rendering or live remote evidence |
| `VirtualMessageList.edgeFade.test.ts`, `VirtualMessageList.session-boundary.test.tsx` | repeated scroll-away/back restores the opaque top edge even when an earlier native listener synchronously commits a virtual window; fractional/top-overscroll offsets, one follow notification per event, current gesture callbacks and old-session cleanup; DOM/CSS contracts, not native repaint or live remote evidence |
| `FlowChatOpeningBoundary.test.tsx` | opening-only activation/scroll isolation, bidirectional focus skipping, programmatic focus return, and reveal cleanup; DOM contracts only |
| `HistorySessionLoadingBoundary.test.tsx` | shared 200 ms indicator delay, immediate settled cold/warm opens, off-screen user-message independence, settled-viewport gating, atomic text/tools/code presentation, interaction blocking, session/device cancellation, failure/inactive/resume/reduced-motion handling and no streaming/remount replay; DOM/animation fixtures, not native paint or live remote evidence |
| `ModernFlowChatContainer.history-state.test.tsx` | history presentation and the submission event |
| `ModernFlowChatContainer.history-restore.test.tsx` | production container/loading boundary with controlled history IO: rollback with/without an intermediate hydration commit, empty history, retired legacy snapshots/bookmarks, cold host transfer, pending-read cancellation, navigation takeover, late success/failure, retry, deliberately empty internal projections with accessible earlier history, and Session switching on local/simulated Peer surfaces; no native layout or live transport claim |
| `flowChatViewportOwnership.test.ts` | the priority order, preemption, expiry |
| `useFlowChatVirtualizer.test.ts` | the offsets-and-positions boundary |
| `useFlowChatVirtualizer.measurement.test.tsx` | `measureRenderedItems` against a real virtualizer, fractional normal-flow sizes and offscreen size reservations across reflow |
| `useFlowChatVirtualizer.follow.test.tsx` | post-reveal history measurement shifts both follow coordinates before paint, stable tail row identity with delayed scroll delivery, and visible output still eases; real hooks with supplied DOM geometry, not native or live-peer evidence |
| `useFlowChatVirtualizer.cascade.test.tsx` | bounded synchronous measurement notifications, cross-frame convergence, ordinary synchronous opening, reader takeover and StrictMode/session cleanup; real hooks with supplied geometry, not native paint evidence |
| `useFlowChatVirtualizer.initial-window.test.tsx` | tail-first window, empty hydration, head default, one-time seed, user-scroll takeover, newly attached rows measured during gestures before observer delivery, smooth-aim target stability and immediate measurement on reader takeover, opening readbacks before native events, suspended viewport, measured-window reconciliation with delayed scroll/scroll-end delivery; supplied DOM geometry, not performance validation |
| `useFlowChatVirtualizer.aim.test.tsx` | the re-aim, and giving it up on takeover |
| `VirtualMessageList.layout.test.ts` | the item-height estimate and the spacer |
| `FlowChatTurnRail.test.tsx` | single-marker emphasis, neighboring hover fan, independent keyboard focus, reduced motion, and rail navigation |
| `useFlowChatSearch.test.ts` | exact matching-block decoration, occurrence counting, and search navigation state |
| `flowChatSearchDom.test.ts` | concrete text ranges and independent highlight ownership across rows and panes |
| `../../selection/flowChatHighlights.test.ts` | exact text-parent scoping across Markdown nodes, shared markers, cleanup and document isolation |
| `../../../infrastructure/appearance/adapters/ThemeTokenAppearanceAdapter.test.ts` | legacy accent projection, alpha preservation, theme changes and paint cleanup |
| `../../selection/flowChatSelection.test.ts` | Markdown selection boundaries, source isolation, repeated text anchors, changed sources and legacy table excerpt offsets across cell presentation wrappers |
| `../../../infrastructure/markdown/MarkdownRenderer.test.tsx`, `../../../infrastructure/markdown/AsyncPrismSyntaxHighlighter.test.tsx` | compiled CSS and product DOM selection boundaries for mixed replies, hidden/runtime bodies, response/thinking tables and fences; table alignment/semantics, unchanged cross-message ranges, real Prism/fallback whitespace, literal single/escaped tildes and double-tilde strikethrough in live/completed/math/thinking renderers; not native selection paint evidence |
| `../../selection/FlowChatSelectionBar.test.tsx` | annotation Dialog focus containment and return, frozen excerpts during scroll/resize, and comment submission |
| `../../selection/useExcerptComposerActions.test.tsx` | main/side draft routing, focus after activation, ordinary child ownership, and stale surface rejection |
| `../../../shared/utils/conversationExcerpt.test.ts` | quote deduplication, source-data framing, and legacy/additive presentation metadata |
| `flowChatSearchPresentation.test.ts` | visible source highlighting and single-line marker geometry, wrapping, scrolling, and clipping |
| `FlowChatHeader.test.tsx` | shared SearchField composition, result controls, input identity while expanding, native-view occlusion declaration for session overview, overview positioning during pane resize/collapse, and the default active-only Agent tree toggle |
| `SessionTreePopover.test.tsx` | Agent selection/cancellation/deletion menus, type-only metadata, active branch filtering with ancestor retention, restoring all agents, and the active empty state |
| `../../services/deleteSessionTreeBranch.test.ts` | Unloaded descendant deletion in child-first order, remote location forwarding, failure retention, and device surface guards |

The resize and production-timeline geometry fixtures cache recursive heights only
within one synchronous read and deliver ResizeObserver entries only for changed
boxes. Their caches never span a DOM/style/row-height change. This keeps repeated
frame checks affordable on CI without relaxing position assertions or timeouts;
test duration is not a product performance measurement.

## Native performance fixtures

When E2E is authorized, build Desktop and current frontend assets, then run the
focused command documented in `tests/e2e/AGENTS.md`:

```bash
pnpm --dir tests/e2e exec wdio run ./config/wdio.flowchat-scroll-native.ts
```

The isolated packaged-app fixture exercises slow and fast bidirectional wheel
input, history paging, draft/search navigation, session restoration, and repeated
long/short session switches. Tool-heavy coverage opens actual shell/edit card
controls, verifies their DOM was collected outside the window, then checks that
expansion survives remounting. Long text searches target narrative/code contents.
Each phase records frame intervals, mounted rows, rectangle reads, DOM scans,
reversals and uncovered viewport geometry. The assertions are P95 < 34 ms,
maximum < 100 ms, no reversal > 4 px, no empty frames or uncovered gaps > 48 px,
fewer than 90 mounted rows, and stable post-gesture position. The maximum budget
is explicitly configurable for different measurement hosts. Run without builds
or other test suites competing for CPU.

Set `OPENBITFUN_SCROLL_STREAMING=1` for the loopback SSE provider fixture. The real
Agent runtime executes four shell commands and four file edits in its temporary
workspace, then receives an initial ~40K Markdown burst followed by continuing
output. The test asserts the actual tool results and edited files, continued
reading position while output grows, reader-scroll frame budgets, return to
latest, and completion. It does not simulate internal store events.

JSON, screenshots, frontend revision and fixture configuration remain in the
printed temporary evidence directory. `OPENBITFUN_SCROLL_DIAGNOSTICS=1` adds
row geometry and scroll-write stacks; use that mode for attribution, not timing.
macOS memory samples report a fixed set of newly created host/WebKit candidate
PIDs. WKWebView does not expose `performance.memory`; RSS is not JS heap size,
and a short switching test cannot establish the absence of a leak. The embedded
driver holds strong element references; sampling releases only disconnected
(stale) driver handles and reports their count. Application caches and data are
never cleared and GC is not forced. Earlier uncorrected RSS switching runs were
contaminated by the driver's retained React trees and are not product leak evidence.

### Findings and architecture

| Scenario | Observed cost / risk | Owning change |
|---|---|---|
| One Turn with hundreds of text/tool groups | Whole-Turn range expansion and tail pinning defeated content-block virtualization; 208 resident rows and repeated geometry reads | Resident DOM follows measured blocks; only the footer/tail shell and active interactions pin rows; direct key lookup for pins |
| Large historical Markdown | A single row hides parse/highlight cost until the wheel crosses into a new giant message | Semantic source-range projection with bounded derived caches and complete canonical data |
| Single huge fence or long tool output | Syntax-token DOM can remain large even with few virtual rows | Exact source retained, offscreen decoration released, indivisible chat fences over 24K characters use source-only rendering; existing terminal/card disclosure ownership retained |
| Streaming and completion | Reprocessing a growing prefix and replay/scanning on historical remount | Stable live source owner, memoized sealed prefixes, suffix-only renderer updates, no settled-history reveal scan |
| Paging, selection, search, reopen | Incorrect gap placement or changed coordinate systems can introduce blank space or move the reader | Tail prefix stays inside its CSS shell; existing viewport writer retained; canonical-to-section search mapping, additive excerpt/bookmark hints and legacy whole-text restoration |
| Repeated switching | Retained token DOM, derived strings or observers can accumulate | Bounded section/search caches under the shared resource budget; observer cleanup; DOM residency soak assertions |

### Local macOS measurements (2026-11-05)

All results use an isolated native macOS arm64 Desktop and packaged frontend.
They are individual local runs, not cross-machine or OS-trackpad guarantees.
Artifacts live in the printed `openbitfun-flowchat-scroll-<suffix>` temporary
folder. Preserve the frontend revision with every comparison. No remote PR was
consulted, as requested for this local optimization.

The first optimization stage compared `bundled-b2c0bd8f26cc91e1` with
`bundled-555562062dd87321`:

| Measurement | Before | First stage |
|---|---:|---:|
| 400-group tool-heavy Turn: peak mounted rows | 208 | 40 |
| Same slow-up phase: rectangle reads | 57,613 | 5,750 |
| Same slow-up phase: P95 | 27 ms | 19 ms |
| 100 Turns × 80K rich text: initial DOM nodes | 13,157 | 1,855 |
| Rich-text DOM after scrolling | 25,401 | 2,250 |
| Rich-text worst fast-up frame | 419 ms | 76 ms |
| Rich-text worst fast-down frame | 356 ms | 29 ms |

These historical numbers are not the final-stage frame distribution. Earlier
ordinary-history, 800-group, 100K single-fence and user-only-tail fixtures passed
scroll/search/draft/restore/switch checks. Tool disclosure survived recycling.

#### First large arrival and typical frames

First arrival is isolated from actual tool startup. A matched ~123K initial
burst on `555562062dd87321` (`6yViWc`) had 22 frame intervals: P50/P90/P95/P99
16/19/19/142ms, one interval above 100ms (4.55%). The subsequent bounded-live,
pixel-overscan stage measured:

| Initial batch | Intervals | P50 / P90 / P95 / P99 | >33.33ms | >50ms | >100ms | Reader-scroll P95 / max |
|---|---:|---|---:|---:|---:|---|
| ~40K (`ilqcIY`) | 28 | 17 / 18 / 18 / 52ms | 1 (3.57%) | 1 | 0 | 23 / 34ms |
| ~123K (`yESAUv`) | 27 | 17 / 23 / 32 / 55ms | 1 (3.70%) | 1 | 0 | 19 / 29ms |
| ~395K (`3ypK5T`) | 27 | 17 / 18 / 20 / 58ms | 1 (3.70%) | 1 | 0 | 22 / 41ms |

These runs executed four real shell commands and four real edits, retained the
reader position while output grew, and persisted every paragraph. Most frames
were already 16–18ms before optimization; the improvement is removal of the
large isolated stall, not a several-fold speedup of every frame. The earlier
160ms combined tool/startup sample is not comparable to isolated text arrival.
The fixture now also records a separate 24-paragraph sustained-follow phase.

Final stage build `6846baf21c4d237e` (`lj3Y1Z`) reran the ~123K case after
animation ownership and excerpt fixes. First arrival (27 intervals) was
P50/P90/P95/P99 17/19/30/54ms: one >33.33ms and >50ms frame (3.70%), zero >100ms.
Sustained follow (131 intervals) was 17/18/19/27ms, max 29ms; active reader scroll
(43 intervals, excluding settle) was 17/17/17/25ms, max 25ms. Neither steady phase
had a >33.33ms frame. Eight real tools succeeded, all paragraphs persisted and
the reader anchor remained exactly unchanged while output grew.

#### Opening sessions

Actual nav-click timestamps exclude WebDriver polling and the scroll-settle wait.
For 100 Turns × 80K rich text, each side has one first UI entry and 11 warm opens.
First UI entry is not necessarily cold storage: startup can prehydrate it.
P95 below uses nearest rank; with 11 samples it equals the maximum.

| Click to interactive | Before (`KS043n`, `1a1f4b7708960a2d`) | Readiness fix (`HsTje3`, `db8f2f725c193a0b`) |
|---|---:|---:|
| Long session, first UI entry | 831ms | 301ms |
| Long session, warm P50 / P90 / P95 | 764 / 785 / 786ms | 205 / 209 / 220ms |
| Short session, first UI entry | 805ms | 237ms |
| Short session, warm P50 / P90 / P95 | 762 / 777 / 782ms | 190 / 204 / 206ms |

The old readiness check waited for the offscreen/unmounted user bubble, exhausting
30 RAF retries. These measurements used a mounted-content/bookmark check. Main
subsequently removed that polling entirely in `06e3472a6`; this branch retains
main's settled-viewport handoff. The measurements below predate that integration
and have not been repeated on the rebased branch.
The sampled backend restore took only 26–31ms, conversion 0ms and store commit
2ms; it was the UI readiness wait that dominated this fixture. This does not
establish every provider, cold-disk, remote or whole-document opening latency.

Final build `6846baf21c4d237e` (`c0JhwF`) passed 24 actual-click openings with no
readiness-timeout trace. Long first entry was 303ms and warm P50/P90/P95
198/215/216ms; short first entry was 223ms and warm 195/197/198ms. Each warm
distribution contains 11 samples. The original paired comparison remains above
so run-to-run noise and percentile definitions are visible.

#### Fast scrolling and paint

Native traces identified 83/166px implicit scroll clamps when code intersections
replaced complete `pre` trees. Bounded rows now retain their decoration for their
mounted lifetime. Three runs of `6b3c89a56a57fcc3` (`6mVGVk`, `iPqSk4`, `mYHsWi`)
had no painted reversal over 4px or geometric white gap, but fast-up P95 was 36ms.

The eight-leaf overscan cap (`0ee4a7b250c892ca`) was then measured three times
(`4pDYaH`, `FETjI5`, `akCdkm`). Active-wheel samples exclude 24 idle settling frames:

| Phase | Active intervals/run | P50 | P95 range | >33.33ms | Maximum |
|---|---:|---:|---:|---:|---:|
| Reading up/down | 122–124 | 17ms | 18–19ms | 0–0.8% | 21–40ms |
| Fast up, 1,800px steps | 125–128 | 17ms | 34–36ms | 5.5–7.2% | 74–79ms |
| Fast down, 1,800px steps | 124–126 | 17ms | 23–26ms | 1.6% | 44–61ms |

Peak tool rows fell to 34. No run had a painted reversal >4px or uncovered gap
>48px. Two of the three runs still failed the unchanged whole-phase P95 <34ms
gate. Fast-up consecutive stalls lasted 231–256ms in aggregate: this remains an
optimization target, and the stage must not be described as universally smooth.
CPU-contended runs (`6XF2Bv`, `Dqp3ur`) are retained but excluded from isolated
performance conclusions; an unrelated encoder was consuming multiple cores.

The separate native-pixel run `9Plic3` compared 128 immediate/settled screenshot
pairs at ±1,800px boundaries. 127 pairs had stable geometry, covering 501 text
fragments; their maximum changed-pixel ratio was zero. One moving-geometry pair
was excluded explicitly. This is sampled WKWebView paint evidence from the
bounded-live stage, not every compositor frame or a final-build OS-inertia test.

#### Memory and animation ownership

Stale WebDriver element handles are released on both sides; product caches and GC
are never manipulated. The first-stage 16-cycle comparison reduced the largest
WebKit candidate RSS from 933MiB to 576MiB; 64 cycles reached 776MiB while DOM
stayed 1,920/1,877. Later 128-cycle native and single-eval soaks both showed RSS
movement/growth despite stable DOM and bounded caches. Repeated driver compilation
therefore cannot explain all of it.

The `6b3c89a56a57fcc3` 256-cycle single-eval soak (`u3Yg3M`, seven minutes including
45s idle) ended at 1,811/1,795 long/short DOM nodes, 1,099,346 logical budget bytes,
and one weakly observed detached transcript root. Largest launch-time WebKit
candidate RSS started at 479MiB, peaked at 881MiB and ended at 704MiB. Concurrent
CPU/memory load and explicit native allocation inspection affect residency, so
this is not a clean process-memory plateau proof. Native allocated bytes rose.

Animation diagnostics (`eXMrzb`) found 126 finished warm-session animations,
127 cancelled loading effects and 126 cancelled Spinner effects still alive after
64 switches and 30s idle. The cleanup experiment (`cjl7uH`, `0e5f99be834eff7f`)
explicitly cancelled and detached their effects: all 379 old effect targets were
released; only the current Spinner retained its target. Old animation wrappers
were still observable. End RSS was 669MiB before / 622MiB after, peak 761/697MiB,
with different starting RSS (660/505MiB); this small sample is not a causal
measurement of total savings. The native effect-target result is the stronger
ownership evidence. The pre-fix diagnostic's DOM gate missed by one node because
its first sample preceded async syntax decoration; the fixture now compares
cycles 8 onward without increasing the 64-node tolerance and retains cold samples.

The extended post-cleanup soak (`9x3ypp`, same frontend) completed 256 cycles in
6m10s including 45s idle. All 1,531 old animation effects had no target; only the
current Spinner remained attached. Long/short DOM was 1,811/1,795, budget bytes
remained 1,099,346 and detached transcript roots reached zero after idle (512
roots observed). RSS went from 605MiB to 686MiB, with quarter medians
609/647/657/678MiB: growth is reduced but not zero, and no plateau is established.
An in-run native heap sample found 4 KeyframeEffects / 4 BlendingKeyframes versus
1,561 / 1,561 in the earlier pre-cleanup native sample. Those samples have
different cycle counts; they establish release of effect graphs, not an exact
per-cycle byte-saving ratio. Animation wrappers remained observable and require
separate engine/lifecycle investigation. DOM/resource budgets, native allocation
and RSS are different measures; none alone proves that the JS heap has no leak.

### Compatibility and verification status

Canonical messages, tool payloads, runtime execution and storage/transport shapes
are not truncated or rewritten. Presentation caches alone are evictable. Source
sections preserve complete fences, lists, tables, math and reference dependencies.
Legacy bookmark/quote navigation can materialize the complete source. New section
hints are additive; quote text remains the older-host fallback. Identical excerpts
in different sections have distinct annotation identities. Whole-source fallback
must reject ambiguous section-local offsets instead of choosing an earlier copy.
Precise new-section navigation on an actual older client remains unverified.

The focused 31-file suite passed 416 tests before the final ownership review;
subsequent eight-leaf tests (15), loading/container tests (20), and shared
Spinner/brand/registry tests (13) passed. Final review passed 331 tests across
25 files covering virtualizer, session boundary, selection and excerpt contracts;
Web UI TypeScript and three frame-statistics tests also passed. Final changed-source
ESLint has zero errors and one Fast Refresh warning for the exported excerpt hook
sharing a component file. Earlier MiniApp style projection and all 28 color-governance surfaces passed. No audit
baseline was raised. `check:web` still has four pre-existing typography violations
in `DeviceWorkspaceSections.scss` and `SceneBar.scss`. Focused E2E typing has
pre-existing shared-driver/workspace-helper errors, documented separately from
changed-file errors; final focused E2E typing reported no changed-FlowChat-file errors.

Native runs cover local macOS only. Windows, Linux/WebKitGTK, live SSH workspaces,
relay Remote Control, Peer Device and Detached Dispatch were not exercised.
Local/simulated-peer unit fixtures are not live remote evidence. Whole semantic
documents and individual huge lists/fences remain potential expensive units.

## Manual

For content-width resizing, check both edge hit areas, subtle hover/focus paint,
composer/transcript alignment, rail and scrollbar gaps, minimum/maximum widths,
light/dark and reduced motion, long virtualized history, and restart persistence.
Local, remote-workspace and peer transcripts share controller-local appearance;
live SSH/Peer, mobile Remote Control and Detached Dispatch were not exercised by
the DOM fixtures and need separate scenario acceptance where applicable.

For text selection, check the floating toolbar and right-click actions in the
native WebView; keyboard selection, Tab, Escape, and Ctrl/Cmd+Alt+B; both main
and ordinary side transcripts; multiline Markdown/code; dark/light and forced
colors; narrow AuxPane layouts; long virtualized history; and switching targets
with existing drafts. Drag across an assistant reply, a short right-aligned user
bubble and the next reply in both directions: turn padding, paragraph gaps and
the empty lane beside the bubble must stay unpainted, with full text still
selectable/copyable. Include direct model rounds, timeline content/group members,
parallel tool capsules, expanded user messages and the full-width edit composer;
check that row height, action alignment and outlying controls remain intact.
In a single reply, include several paragraphs, bold/link runs, wrapped lines,
tight and loose nested lists. Select through the last paragraph in either
direction: the right-hand blank and inter-paragraph/list gaps must stay clear.
Repeat inside a collected group, retry history and a subagent projection, and
confirm hidden reply bodies remain hidden while their source text stays mounted.
For tables, include short/long cells, left/center/right alignment, inline links,
code and emphasis, wrapped rows, and horizontal overflow in a narrow pane.
Select across cells and rows in both directions: padding and unused row height
must stay clear, while text remains selected and copied with native table
semantics. Locate a table excerpt saved before the cell-wrapper change.
For fences, select from the preceding paragraph through the following paragraph,
then partially within code. Include labelled/unlabelled one-line fences,
indented multiline code with blank lines, syntax tokens, long scrollable lines,
streaming responses, completed responses and thinking. Check both outer fence
insets and right-hand line blanks stay unpainted, source whitespace survives
selection/copy, and line hover/copy controls remain usable.
Remote workspace and desktop-peer sends, older-host quote
fallbacks, disconnect recovery, and CLI-peer/dispatch unsupported states require
separate real-host checks. Unit fixtures are not evidence of those scenarios.
Annotation editing, draft management, and sent annotations use the public Dialog
anatomy. Check initial focus after the context menu closes, Tab containment,
Escape/cancel focus return, one-line quote truncation, and save-and-locate from
pending source marks and composer attachments without losing the comment. Sent
annotations must display the sent comment without input/save controls and retain
source navigation, including when a same-ID draft exists in the composer.
Sending must consume the source superscripts and persistent highlights; loading
history must not restore them. Deleting from a source-marker dialog must remove
only that pending annotation from the composer or queue and close the dialog.
The first ordinary side question forks the parent on send. Model and reasoning
choices stay in its draft until that request; its Agent mode is inherited.
Its permission control reads the parent and becomes editable after submission.
Peers advertise `btw_initial_model_selection_v1` for legacy fixed-model draft
settings, and `btw_model_pool_selection_v1` for typed model/pool choices. Inherited
pools send no scalar override and retain the parent's current binding under both
routing strategies. Older hosts retain inherited settings and readable quotes.

For completed-turn image export, check both option cards in light/dark and
high-contrast themes: hover, press, and keyboard focus change the neutral fill
without changing size or selection; only the checkbox indicates the selected
output. Check reduced motion and touch input separately. Check the captured image's
user bubble against the live message, full long text/reference labels, minimal
brand/date header and attribution footer, and absence of all thinking items/icons
in compact output. Verify that many model rounds retain their inter-item gaps
without accumulating empty space above the footer, and that long tool summaries
respect the horizontal inset. Exercise both system and bundled font profiles on
macOS, Windows, and Linux. The same presentation
on remote-workspace and peer-host sessions remains a real-host check.

**Agents must not perform UI interaction verification.** Report these as pending
unless a human confirms them. They are grouped so that adding a check to one
group does not renumber the others.

### Opening a session

Check the sparse history placeholder in light/dark themes and wide/narrow panes:
the left lines retain a normal 24px height, the upper-right user bubble has equal
rounded corners and no border, and the composition shares one soft light field.
Open text-only, tool-only and long-code histories, including a restored bookmark.
The abstract layer must disappear completely before real content reveals; no
thin-line intermediate state or jump in the reading position is acceptable.
Switch sessions/devices rapidly, fail and retry a load, and toggle reduced
motion. Local, remote-workspace, Peer Device and detached-dispatch observer
histories need separate real-host checks; mobile Remote Control uses its own UI.

For the top edge fade, scroll down and all the way back to the first message
several times. Its first line must be as readable as on initial open; leaving
the top must restore the fade. Check native WebViews, light/dark themes and
forced colors. Automated DOM/CSS checks do not establish this paint behavior.

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
7. Alternate between two long sessions several times. Each reopen must paint
   its rows at their final heights, with no settling movement or scrollbar-thumb
   jump. Repeat after resizing the pane while the other session is shown. Then
   visit three other sessions and return: that reopen may settle as a first
   open does. Pending: native switching time has not been measured with
   retention.

### Submitting and revealing

For user-message disclosure, compare a short message with a long message whose
first lines are short and later lines are wide. The collapsed preview stays
compact; expanding grows leftward only as needed and downward, keeping its right
edge aligned. Collapse restores the compact width. Repeat with images, reference
capsules, failed messages, editing and a narrow main/side pane. Verify long
expanded text still scrolls within its height limit. Local, remote-workspace,
Peer Device and detached-dispatch observer views require separate real-host
checks; mobile Remote Control uses its own message renderer.

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
8. A new message gently settles, followed by its timestamp and action group,
   within about 300ms. A quick reply appears immediately. Scroll the message out
   and back, switch sessions/devices, or reconnect: settled messages must not
   replay. Tab to an action during feedback and enable reduced motion: controls
   must become fully visible immediately. Repeat with attachments and in ordinary
   side conversations. Local, SSH, and Peer Device sends and detached-dispatch
   observer projections require separate real-host checks.
9. Compare user text, its timestamp, reply prose, and completion metadata: their
   leading edges must match the start of the bubble's straight horizontal border,
   after its rounded corner. Both action clusters' last icon frames must align
   with the opposite tangent point. Repeat in a narrow panel,
   with wrapped text, attachments, failed messages, missing timestamps, and
   different available actions. Controls must retain their full hit targets and
   wrap as a cluster without horizontal overflow. These are manual visual checks;
   source checks and Sass compilation do not establish rendered alignment.

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

1. Expand and collapse a tool card so the transcript alternates between fitting
   and overflowing the viewport. Message widths and horizontal positions must
   stay fixed, including with the OS set to always show scrollbars. Repeat in
   desktop WebKit and Chromium hosts, with both narrow and wide chat panels.
2. Drag the scrollbar to the very bottom. The screen must not be entirely
   blank: the last Turn and the input clearance stay visible above the
   reservation. Repeat with the composer expanded, which consumes the spacer
   before the three-quarter cap can be exceeded.
3. Drag the scrollbar, without touching the wheel first, down into the reserved
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

For rollback, start with an older history range visible, roll back one Turn,
then roll back to the first Turn. The view must reveal the surviving tail or
empty Session, and switching away/back must not revive the removed bookmark.
Repeat while a cold bookmark read is pending, with a second controller
initiating the rewrite, and after a failed history read followed by Retry.
These native and live Peer checks remain manual; the container fixture controls
IO timing.

1. On local and peer devices, open a long session whose last Turn is short.
   Only that Turn starts at the top, with blank space below; background history
   must not fill the blank. Repeat with a long last Turn: its end is visible.
   After the first presentation, any adjacent prefetch adds content above without
   remounting or moving the visible rows. Switch away and back: no full-history
   drain or new placement. Test an older peer host separately for its compatible,
   potentially slower record-page fallback. Then send a message: it appears in
   the one-shot live-tail reveal without reloading the history above.
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

For trajectory navigation, check user, model, folded-tool and historical-round
targets in light/dark themes. The target receives a temporary full-item accent
fill; the short tool marker sits left of its icon. Rail selection and right-panel
content change only after successful positioning. These native visual checks
remain manual; DOM geometry and transport fixtures do not establish native or
live-remote rendering behavior.

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

### Accepted steering

1. Send immediately during a long tool/model round in the main transcript and
   BTW pane. After host acceptance, verify the message uses the ordinary user-message
   appearance without a pending label and leaves the composer queue. Confirm long text and attachment count.
2. Let the formal Turn start. Verify one message remains and
   attachments appear normally. Send multiple messages and check ordering.
3. Exercise blocked handoff, history navigation, transcript closure, disconnect,
   reconnect, host restart and device switching; recovery controls must remain
   available and another device's preview must never appear.
4. Repeat on a remote workspace and Peer Device host with two controllers, one
   sending from mobile. Mobile retains its existing queue UI. Check an older
   host without display receipts retains the existing desktop queue UI. Detached
   dispatch and ACP use their existing paths and have no preview requirement.

### History paging demand

1. Page upward at least three times from a long session's live tail, and page
   downward again through a history window. Both directions must keep working.
2. Trigger prefetch before reaching the physical head; stop while it loads.
   Correction/measurement alone must not cascade through subsequent pages.
3. Keep scrolling during a slow page; queued demand should continue once the
   page commits if the new boundary is still near. Reverse or move away during
   the fetch and verify the obsolete demand does not load another page.
4. On a transcript shorter than one viewport, wheel upward at the hard top.
   Test keyboard, touch/inertia and scrollbar dragging as well.
5. Navigate elsewhere or switch sessions during a slow fetch. Its eventual
   result must not block the new boundary or move the new presentation.
6. Repeat on remote workspace and Peer Device surfaces with transport latency;
   local unit fixtures do not establish those behaviors. Remote-control/mobile
   and detached-dispatch surfaces do not use this list controller directly.
