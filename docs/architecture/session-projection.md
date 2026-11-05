# Session Projection

What a client shows for a Session is a **projection of an ordered stream**. This
document is the contract that projection obeys, and the migration that brings
the existing writers under it.

Read [`peer-device-mode.md`](peer-device-mode.md) for how a controller reaches
another device. This document is about what happens to the data once it
arrives, and applies identically on the local surface.

## Interaction and attempt ownership

The current mailbox reconciler updates both representations of a model round:
`attempts[].items` owns attempt-aware rendering and subsequent streaming writes;
`items` is its flattened projection used by attention indicators and consumers
without attempt support. Recovered questions, including child-agent questions
projected into the controlling parent Session, must enter the current
non-diagnostic attempt. Diagnostic attempts remain history. Legacy rounds without
attempts keep their flat representation.

Reconciliation applies replacements and removals to both representations before
publishing the Session. An authoritative empty mailbox removes pending synthetic
cards but preserves completed tool results. Replaying the same revision must not
remount the card or erase drafts. A mailbox-only update must survive the next
ordinary stream update; merely asserting that the flat list contains a question
does not prove that FlowChat can display it.

## Read lifecycle and multi-session isolation

`SessionStream` owns both the read fence and whether a read is in flight. A read
ends exactly once; completion, abandonment, supersession, and attachment disposal
must make its old handle unable to affect a subsequent read. Returning to a
healthy projection wakes pending-message consumers even when the terminal state
was replayed while the fence blocked submission. Those wakeups are coalesced and
bound to the rendered surface epoch.

Replayed lifecycle events establish Turn ownership before newer held events are
released. Changing Runtime process resets old ownership; a same-process snapshot
behind the applied position cannot clear a delivery gap. A discarded queue keeps
the original surface stale for replay rather than delivering to another device.
The transport also checks the captured surface epoch and surviving subscriptions
at delayed delivery time; replacement listeners cannot receive old events.

A Session restore fences only that Session. Events buffered for other Sessions
during the read must be flushed, never cleared with the restored projection.

## The problem this replaces

Seven independent writers currently produce a Session's on-screen state:

| # | Writer | Entry point |
|---|---|---|
| 1 | Live agentic events | `AgenticEventListener` → `eventBatcher` |
| 2 | Disk hydrate | `loadSessionHistory` → `restore_session_view` |
| 3 | Windowed history | `load_session_turn_window` |
| 4 | Snapshot reconcile | `refreshPeerSessionSnapshot`, `replaceRunningSnapshot` |
| 5 | Journal snapshot replay | `dispatchExternal(snapshot.events)` |
| 6 | Interaction mailbox | `reconcilePendingUserQuestions` |
| 7 | Backfill delta | `load_session_event_backfill` |

None of them carries a position that the others can compare against, so every
pair needs its own conflict rule. Those rules are the fourteen invariants in
[`peer-device/README.md`](../../src/web-ui/src/infrastructure/peer-device/README.md),
and they are written in terms of painted content rather than ordering:
`snapshotDropsProjectedTurnContent` decides whether a write is safe by counting
rounds and progress entries; `runtimeProjectionCaughtUp` decides whether a
cursor may be trusted by looking for tool cards on screen.

Counting pixels to decide whether a write is safe is what a missing position
looks like. The rule table also grows quadratically: adding writer 7 required
two new pairwise rules (7↔1, 7↔6), and shipping without them produced exactly
two defects — the live stream stalled behind writer 7's fence, and a blocking
interaction came back unanswerable because writer 6 never ran.

## Contract

### 1. Every write carries a position, and the projection never regresses

A write whose position is not ahead of what has been applied is **dropped, not
merged**. There is no operation that replaces projected content, so no writer
needs to prove it is not about to lose any.

Positions are per `(surface, session)`:

- **Runtime positions** — `(streamId, cursor)`, minted by the Host journal as
  each event enters its ordered delivery stream. `streamId` identifies the
  Runtime process; cursors from different `streamId`s are never comparable.
- **History positions** — turn ordinal within the persisted record. Immutable
  and totally ordered.

The two are not compared with each other. They cannot conflict, because of
invariant 2.

### 2. A Turn has exactly one writer, decided by whether it is executing

- An **executing** Turn is owned by the runtime stream. No persisted record,
  checkpoint, or snapshot of that Turn may write it.
- A **settled** Turn is owned by the persisted record. No live event may
  write it.
- A terminal event starts client settlement, but it is not proof that the
  terminal record is durable. Ownership transfers **once**, at the Runtime's
  post-persistence history fence, driven by position — never by inspecting
  what is on screen.

This is why history and live events cannot race: they are never both
authoritative for the same Turn. The persisted checkpoint of an executing Turn
is identity only; it names the Turn and carries none of its content.

Native Runtime completion is rebuilt from the complete generation journal under
the same per-Session mutation lock used by projected saves. A projected
checkpoint may contribute additive display metadata, but it cannot shorten
canonical text or thinking, remove a round or tool result, or turn a settled
record back into an executing one. Externally projected sessions such as ACP
remain owned by their external projection.

Native Turn completion also reconciles cumulative token usage from the executing
host's durable request ledger before publishing the settled record. The query
uses native request-attempt identities scoped to the Session and Turn, including
retries and recovered generations. Auxiliary tool calls and unattributed legacy
ledger rows do not enter the rate. Completion does not depend on a controller or
its last debounced save.
Ledger reads happen before the Session mutation lock. Missing or unreadable usage
retains the checkpoint, and unreadable data is logged without resetting it.
Later projected saves cannot reduce an already observed aggregate. Clients talking
to older hosts likewise retain a more complete live aggregate when adopting the
settled record. Unknown cache telemetry stays unknown. This does not change the
output-rate denominator or backfill historical Turns on read.

A client can miss the terminal event entirely, for example while the window
renders another device surface. Its stream then still believes the Turn is
executing. A host read that reports the Host's own state resolves this: the
Runtime commits the terminal record before leaving the processing state, so a
terminal record for a Turn the Host is not executing is the settled Turn. The
client hands that Turn to the persisted record (`adoptHostSettledTurn`) instead
of letting its stale ownership veto the read. The remaining content guard is
shape-neutral: it refuses a read that misses a painted round, tool, tool result
or text, but not one that differs only in attempt metadata, newline coalescing
or segment boundaries.

After the terminal record is committed, `SessionHistoryChanged` is the durable
fence. Local and Peer Device surfaces re-read the affected tail Turn. Remote
Connect polling sends an optional authoritative `message_snapshot`, because an
already-counted assistant message can grow from a streamed prefix to its full
persisted content without changing message count. New clients accept the
snapshot; older clients continue to use the existing additive fields.

### 3. Identity is `(surface, session)` by construction

One `SessionStream` object owns the position, the pending queue, and the
projection for one `(DeviceSurfaceId, SessionId)`. Workspace paths and session
ids repeat across machines, so surface is part of identity, not an extra
argument each feature remembers to thread through.

Any state that is per-Session is reached through its stream. A feature cannot
hold Session state that is not surface-scoped, because there is nowhere to
put it.

## Web UI selection and scene lifetime

`FlowChatStore` owns the selected session on the active device surface.
`ModernFlowChatStore` is its presentation projection, not a second selection
owner. Synchronization includes an empty selection and a missing selected
record, both on subscription and after every source change. Explicit sync from
an async opener cannot select a different session. Shell and standalone chat
hosts share one source subscription.

`sceneStore` owns resource tabs and their navigation history. A Session tab is
keyed by `(device surface, owning workspace)` and holds only a session reference.
Opening another session in that workspace replaces the reference in place;
other workspace tabs retain their references and order. The owning workspace
is the project root even when execution runs in a worktree. Workspace ids are
preferred; older metadata falls back to scoped local/SSH roots without changing
persisted records. Labels show only the referenced session title; workspace
ownership stays in the resource identity. Background title updates are scoped
to their own tabs and never follow the currently selected session.

The design system's `TabGroup` receives `labelTransitionKey = sessionId` for
session slots. Its public `RollingText` component owns vertical replacement,
width interpolation, interruption, reduced-motion preference, and accessibility.
Session title edits and focusing a different workspace do not replay replacement.
The shell does not own animation snapshots or timers.

`app/services/sessionSceneLifecycle.ts`, installed for the `AppLayout` lifetime,
provides the resource activation adapter. Tab clicks, shortcuts, history, and
close fallback all activate the workspace and session through that adapter
before committing navigation. Workspace activation is ordered, and superseded
navigation cannot select a session after its history finishes loading. The
scene store handles the tab transaction and settings-draft exit; the adapter
uses the existing session/workspace owners for resource activation.

`SceneViewport` mounts one Session presentation host for all workspace tabs.
Tab identity and scene-host identity are separate: chrome, file/terminal
routing, voice context, and the customization facade still address the
`session` scene. No additional global composers or runtime subscriptions are
mounted for background tabs.

When a referenced session no longer exists, reconciliation removes its tab and
history, including background tabs. A temporary empty selection does not remove
other records' tabs. Closing a tab does not delete or stop a session; closing the
final tab exposes the tabless empty surface. Device-surface changes reset the
shell tabs without deleting either device's session container. Creating or
opening a session establishes its record first. Loading, offline, and failed
history records remain recoverable; absence of rendered turns is never evidence
of removal.

This is frontend view reconciliation. It does not delete persisted sessions,
create replacement sessions, or change the runtime state machine and remote
wire contracts.

## Navigation activity and result receipts

The sidebar consumes an application-lifetime summary projection, independent of
opening a Session scene. `sessionNavStatusService` owns one set of lifecycle,
permission, state-machine and dispatch subscriptions; rows subscribe only to
their cached `(kind, pendingCount)` value. Token streaming does not trigger
network reconciliation, and repeated `processing` phase events do not invalidate
an already running summary. Permission changes reconcile only their Session owners
and delegated parents, rather than every row in the sidebar.

`list_persisted_sessions_page` has an additive `activities` response extension.
The normal page includes the activity of its rows. An optional `session_ids`
request selects at most 128 compact summaries without returning metadata rows.
Both Desktop and CLI Peer Host use `CoreAgentRuntimeCompatibility` to join the
metadata index with the existing Session manager, scheduler and interaction
mailboxes. Initial pages do not restore Sessions, read Turn/state sidecars, clone
full runtime Sessions or acquire transcript-attachment fences. Metadata index reads
still scale with the index size; the bounded batch limits transfer and runtime
projection work, not the storage index's deserialization cost.

The latest user-Turn identity, generation and outcome are maintained in optional
`SessionMetadata.lastTurn` alongside existing metadata writes. The existing
`recoveryEpoch` preserves the generation after recovery settles. Headless terminal
writes also mark the existing unread field. Re-saving a terminal checkpoint does
not revive an acknowledged result. The optional `lastTurn.recoveryPending` fact
distinguishes a resumable interruption from an ordinary cancelled Turn; older
summaries omit it. Runtime execution, persisted outcome/recovery and read receipt
are separate facts. Running, queued, permission/question waits and resumable
pauses remain visible regardless of reading. Completed, failed and cancelled
results are notifications and disappear after acknowledgement, without changing
their persisted outcome. Even a runtime `error` state is not itself an unread
notification. A stale transcript cannot override a supplied host outcome or a
known absence of recovery; a missing old recovery fact may use the matching
hydrated Turn.

Legacy rows lacking a latest-Turn fact (or the recovery fact for cancellation)
remain immediately listable. Their activities are omitted from the initial page
so the existing application synchronizer schedules a targeted batch. Only that
batch lazily reads backward to the latest user-Turn file, skipping maintenance
Turns. It decodes identity/outcome fields without materializing message/tool
payloads, never loads runtime state and has two process-wide repair slots. The
existing per-Session writer locks fence metadata re-reading and repair, so a
concurrent result, acknowledgement, rename or deletion wins. Repair writes only
the missing summary and preserves unread state and timestamps; subsequent reads
use the index. It never recreates unread notifications for old results. Staged
revert projections are not persisted over the physical history. Unreadable
entries keep their Session data and are omitted individually, using the existing
missing-activity retry/backoff path instead of claiming an idle outcome.

The frontend coalesces invalidations for 100 ms, groups by owning workspace and
remote identity, and permits two concurrent batches. A single liveness timer
reconciles subscribed busy rows after 15 seconds and settled rows after 60 seconds;
hidden windows skip those probes. Focus, visibility, online and surface activation
trigger a new read. Failed requests back off to 60 seconds. In-flight reads are
fenced by surface activation, per-Session event version and request sequence;
switching devices also cancels queued old-host batches. An older host omitting
`activities` retains the event/metadata path, with unknown status shown explicitly
and no repeated unsupported batch requests. There is no local transport fallback.

Completion unread state belongs to a specific result. Main and Btw viewports
acknowledge only after the final projected item of that result is actually visible
in a focused, foreground, settled viewport; selection and overscan are not read
receipts. A Turn stopped before producing any output uses its visible input
boundary; an existing result or error notice must itself be visible. Maintenance
and local-command Turns do not replace the latest user result or its receipt.
A newer summary cannot be acknowledged by an older transcript still on
screen. Local acknowledgements survive overlapping summary reads, and persisted
acknowledgements compare Turn, generation, outcome and the known recovery fact
(with a finish-time compatibility guard for older clients). Notification saves send only their two owned metadata fields,
without loading the metadata record first. CLI Peer Host accepts these notification
fields through the existing `save_session_metadata` command; other metadata edits
still return an explicit unsupported response.

Remote workspace scope stays with the existing host storage resolver. Remote
Connect/bot-started native Turns feed the same runtime events and persisted
summary. Peer surfaces remain isolated even when session IDs coincide. Detached
Dispatch rows use the existing target observer and permission source and are
excluded from native summary/persistence requests. Automated contract tests cover
these routing and race boundaries; they are not end-to-end evidence for live
remote hosts or native visual acceptance.

## Sources are not writers

Every source above becomes a way of **obtaining positioned events**, applied
through one path:

| Source | Produces |
|---|---|
| Live DeviceEvent / local emit | events at `(streamId, cursor)` |
| `load_session_event_backfill` | events after a position, or `snapshotRequired` |
| `restore_session_view` runtime snapshot | a compacted prefix ending at a position |
| `restore_session_view` turns / `load_session_turn_window` | settled Turns at history positions |
| Interaction mailbox | revisioned state of an executing Turn, applied at its position |

A snapshot is a prefix. A delta is a suffix. History is the older part of the
same order. None of them is a distinct kind of write.

## What this deletes

Each item disappears when its writer migrates. This list is the acceptance
criteria — a migration step that does not remove its entry has not finished.

| Removed | Replaced by |
|---|---|
| `replaceRunningSnapshot` | there is no replace operation (contract 1) |
| `runtimeProjectionCaughtUp` | the applied position is the answer (contract 1) |
| `prepareRuntimeTurnReplay` / `asRuntimeReplayTurn` | an executing Turn has one writer (contract 2) |
| `hasGap` / `projectionStale` / `markRuntimeSessionProjectionStale` | a position discontinuity is the gap |
| `beginRuntimeSessionAttachment` fence | the stream's own queue (contract 3) |
| manual `(DeviceSurfaceId, …)` threading | stream identity (contract 3) |

The 3s poll is **not** on this list. Events that never arrive advance no
cursor, so no discontinuity is observable; the poll remains the liveness probe
that notices a stream has gone quiet. It stops being a repair mechanism.

### Two gaps the contract does not yet close

Both were found by deleting a heuristic and watching a behavioural test fail.
They are why `snapshotDropsProjectedTurnContent` and
`isRunningSnapshotForwardProgress` survive, inside
`persistedReadMayReplaceTurn`, as the last content comparison in the merge:

- **A Host that serves no runtime projection.** Contract 2 hands an executing
  Turn to the runtime stream, but an older Host has no such stream. Its
  persisted checkpoint is the only progress that exists, so forward progress
  from it is still admitted when `runtimeEventSnapshot` is absent.
- **A partial history read.** History positions are turn ordinals, and a
  windowed or not-yet-checkpointed read can name a Turn while carrying none of
  its work. Such a read holds no position for the content it omitted, so
  writing the Turn from it is lossy rather than advancing. Closing this needs
  the read to report its own completeness; until then "would this write lose
  content" is the only question available. The comparison includes content
  prefix progress and completed tool results, not only round or item counts.

Deleting either guard without first closing its gap reintroduces a real defect,
not just a test failure.

## Migration

Ordered so that each step is separately verifiable and deletes its own rules.

1. **Position algebra + `SessionStream`** — the contract as a tested module,
   with no writer on it yet.
2. **Runtime-stream writers (1, 5, 7)** — live events, snapshot replay, and
   backfill are already positioned; move them onto the stream and delete the
   fence, `hasGap`, and `runtimeProjectionCaughtUp`.
3. **Snapshot reconcile (4)** — becomes "apply a prefix"; deletes
   `replaceRunningSnapshot` and `snapshotDropsProjectedTurnContent`.
4. **Interaction mailbox (6)** — applied at the executing Turn's position
   rather than as a separate reconcile pass.
5. **History (2, 3)** — settled Turns at history positions; deletes the
   executing/settled overlap rules and `prepareRuntimeTurnReplay`.

Steps 2–5 each remove entries from the peer-device README's invariant list.
That list shrinking is the measure of progress; if it is not shrinking, the
step reintroduced a pairwise rule instead of removing one.

## Host contract

Hosts expose exactly two reads over a Session's stream, both already present:

- `restore_session_view` — a prefix (compacted projection + settled Turns +
  mailbox), ending at a position.
- `load_session_event_backfill` — the suffix after a position, or
  `snapshotRequired` when contiguity cannot be proven.

`SessionEventJournal` owns both. The compacted projection answers "what does
this Turn look like now"; the append-only tail answers "what came after
position N". Neither is allowed to answer the other's question — that
conflation is what made a gap something to infer.

Peer ownership is a cancellation and bookkeeping boundary and never filters
either read. A Turn started in a Host's own TUI is part of the Session every
attached surface projects.
