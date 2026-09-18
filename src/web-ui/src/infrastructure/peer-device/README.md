# Peer Device Mode (frontend)

Controller-side React/transport layer for Peer Device Mode. Architecture:
[`docs/architecture/peer-device-mode.md`](../../../../../docs/architecture/peer-device-mode.md).

## Relay session ownership

The selected Desktop or CLI owns execution, persisted records, workspaces, PTYs,
and blocking interactions. A controller owns presentation and drafts. Its lifetime
never determines whether an accepted turn continues running.

`RelaySessionHistory` owns one subscription per visible surface/session.
`SessionRecordReplica` applies both replayed pages and live canonical records
using stable IDs, revisions and tombstones; every page comes from the online
host, and a stream-epoch change (host restart) drops the replica before replay. Following Happy's sync owner,
the latest page paints first; older pages share one in-flight reader and are
prefetched with a yield between pages. Receive cursors advance only after applying
records, never from a send acknowledgement. Transport reconnect resumes that same
subscription. Local Runtime projection machinery is not a second Relay content
writer: peer token/body events must not overwrite canonical records.

The independent Runtime interaction mailbox restores unanswered questions and
permissions without fetching the transcript. Keep its revisions and surface fence
separate from history pagination. Neither a WebSocket connection nor an event
listener alone recovers an interaction emitted before attachment.

## Invariants (do not regress)

0. **A surface switch is a view change, not a teardown.** Attachments and the
   rendered surface are independent: peers stay attached after the UI moves elsewhere; accepted work
   remains owned by the runtime even when every controller disconnects, and `switchToLocal` is a switch, not a
   disconnect. Two consequences:

   - Everything in `resetProductSurface()` must be **frontend-only**.
     `resetProductSurface` runs before the transport swap, so any backend call
     it makes lands on the device being *left*. `terminal_shutdown_all` and
     similar lifecycle calls can kill work an agent turn there is still using
     (regression: 2026-08-14 multi-device switch). Use frontend-only listener
     detachment such as `TerminalService.disconnect()`.
   - **Identity includes the device surface.** Workspace paths and session ids
     can be equal on different machines. FlowChat/workspace containers,
     state machines, processing status, pending messages, composer drafts,
     request dedup and capability caches must therefore use
     `(DeviceSurfaceId, local identity)`. `activateSurface` commits transport,
     event routing and container selection before notifying observers. A normal
     switch preserves every container; only explicit attachment disposal
     may call `discardSurfaceState`.
   - **In-flight submissions must survive the switch.** `startTurn` has an
     async window between adding the projection turn and re-reading the
     session (state transition, worktree bind, model sync). Clearing the store
     inside that window made the submission resume against a missing session
     and throw `Session lost after adding dialog turn` — before
     `start_dialog_turn`, so the message reached no host at all (regression:
     2026-08-15).      `resetProductSurface` therefore awaits
     `waitForInFlightSubmissions` first. `sendMessage` and its driver carry one
     `SurfaceScope`; after every host await, a stale epoch abandons without
     writing into the newly selected container, and an unaccepted message is
     re-queued onto its original surface. Once `start_dialog_turn` has been
     invoked, the host may already own the Turn before the client sees the
     ACK — that submission must not be re-queued, and attach must drop any
     pending-queue item that duplicates a live turn's user message. Drain
     must not fire while a Runtime attach is resetting the state machine to
     IDLE. Any new await inside `startTurn`
     widens that window and must keep the same scope checkpoint.
   - **Surface-scoped events must stay routed by source device.** Background
     attachments mean several agent streams share one event bus. The
     controller tags re-emitted peer payloads with `__openbitfunSourceDeviceId`
     and `deviceSurfaceRouting.ts` (applied inside
     `TauriTransportAdapter.listen`) drops anything not produced by the
     rendered device. Adding a fanned-out event on the Rust side means adding
     it to `SURFACE_SCOPED_EVENTS`/prefixes too, or local and peer streams will
     interleave in one store. Never route control-plane events (`account://…`)
     — they must always pass.
   - **React subscriptions include the Surface activation.** A Session id is
     not a complete subscription identity. Hooks that read per-Surface state
     machines subscribe to the Surface epoch and return no snapshot during the
     rebind render; otherwise React can pair A's old `turnId` with B's Session
     for one render, including when both devices use the same Session id.

1. **Relay subscriptions stay on the controller.** The account subscription
   commands open host-owned streams on the selected runtime (`read_stream`
   pages plus encrypted `host-stream-changed` hints, both forwarded by the
   relay without storage). Product commands such as listing sessions execute
   on that runtime through HostInvoke. Never route a controller's subscription
   back onto the peer, and never substitute relay-side or local caches for a
   host that is offline: an offline host has no history to show.

2. **Peer history has one owner.** `loadSessionHistory` uses
   `RelaySessionHistory`; it must not fall back to `restore_session_view`, cloud
   imports, or a local transcript after a Relay failure.

3. **Failures stay explicit and recoverable.** Failed reads leave loading state,
   retain previously rendered records, and expose retry. An empty success is not
   a substitute for an unavailable runtime or unsupported capability.

4. **Clear `FlowChatManager.currentWorkspacePath` on peer switch.** Stale
   controller paths (e.g. Windows) must not be reused for `create_session` on a
   peer host (e.g. Mac). `initialize()` failure must **throw**, never return
   `false` (callers treat `false` as “no history → create session”).

5. **Create-session always passes the live workspace path**
   (`flowChatSessionConfigForWorkspace`). Empty `{}` configs are unsafe after
   peer switch.

6. **Config / mode HostInvokes are high priority** during peer hydrate
   (`get_config`, `get_configs`, `get_available_modes`,
   `get_agent_profile_config`). Keeping them `low` can still delay hydrate
   behind a burst of background RPCs.

7. **Account identity commands are LOCAL_ONLY** and must stay denied on the
   peer host (`account_login`, `account_finalize_login`, logout, device RPC,
   …). The FE adapter, desktop `peer_host_invoke`, and CLI `peer_host` all
   derive that set from one registry row (`peer: ControllerLocal` in
   `src/crates/contracts/product-domains/src/remote_surface/table.rs`); the
   FE set is the generated `PEER_CONTROLLER_LOCAL_COMMANDS`. Do not add a
   hand-written list on any surface. See
   `docs/architecture/remote-surface-contract.md`.

8. **`relay_deploy_*` is LOCAL_ONLY.** One-click deploy SSHes from the
   controller to a user-owned host; do not HostInvoke it onto the peer.

9. **Select workspace state atomically with transport.** Before commit,
   `workspaceManager.clearForPeerModeSwitch()` invalidates work still in flight
   but deliberately preserves the device being left. `activateSurface` then
   selects the target's cached workspace container in the same synchronous
   commit that swaps transport, before the peer-mode event. SessionModule must
   never observe A's path with B's transport. Never pass `{}` to
   `createChatSession` when a live workspace exists — use
   `flowChatSessionConfigForCurrentWorkspace`.

10. **Download destinations stay on the controller.** Native dialogs select a
    path on A. Read file chunks from B with direct Peer commands, then write
    them through A's local filesystem adapter. Do not HostInvoke
    `export_local_file_to_path` with A's path. Directory downloads must preserve
    the tree and reject traversal-like entry names.

11. **Terminal traffic stays interactive and observable.** All `terminal_*`
    commands are high priority within each submission burst and use the shared
    transport admission policy. Both local and SSH-backed PTY cursors on B must
    notify A without placing raw output into an unbounded event queue.
    Remote `SIGINT` / `SIGTSTP` map to PTY control bytes instead of silently
    succeeding without affecting the process.

12. **Canonical records and control events have different owners.** Completed
    semantic text/tool blocks enter the runtime's durable session log. Replayed
    pages and live records use the same replica, revision rules and tombstones.
    A disconnected controller resumes from its receive cursor and deduplicates
    records; it does not reconstruct a running turn from a second full snapshot.
    Lifecycle and approval events may update controls, but raw token/tool-body
    events cannot overwrite the canonical content owner.

    `get_session_interaction_mailbox` returns the Runtime's revisioned pending
    questions and permissions on attach/reconnect. Apply it with a captured
    Surface scope and newer-event fence. Answers carry the owning session and
    request/tool identity; the runtime validates them. A controller switch does
    not restart a question deadline or cancel an accepted turn. Any interaction
    that can suspend execution needs a recoverable mailbox and response path.

13. **Weak links use bounded, idempotency-aware recovery.** Presence gaps
    and product RPC timeouts keep an attached peer's surface selected and request
    a silent control probe. Only a failed control ping or re-attach marks the
    connection degraded and shows the compact status beside the device controls.
    A roster omission still requests event re-attachment even when ping succeeds;
    a failed product request alone does not require re-attachment. A single dedicated handshake owns recovery and its
    retry counter; concurrent product failures must not consume it or postpone
    the timer. Retry delay is capped, not retry lifetime. A successful recovery
    re-attaches event delivery before publishing `ready`, without changing the
    surface epoch, discarding state, or resubmitting work. Only explicit
    disconnect or logout disposes an attachment.

    Request admission and byte budgets belong to the shared transport owner.
    Avoid independent UI slot limits or polling loops that compete with recovery.
    Mutations are not automatically replayed without an idempotency contract.
    Dialog submissions reuse `(sessionId, turnId)` so an ambiguous acknowledgement
    does not create another turn. A failed session list must leave loading state
    and offer an explicit retry.

14. **History navigation uses the same canonical replica.** Latest-page loading,
    older-page prefetch and explicit full-history requests share the subscription.
    The controller builds the turn catalog from canonical turn identities after
    older pages are complete, preserving actual storage indices. Turn navigation
    must not introduce a second `restore_session_view` or window-RPC content owner.
    Rollback remains an explicit runtime operation; it never falls back to a
    controller-local mutation. Never log catalog preview text.

15. **Git ownership trust is read on the peer, granted at the machine.**
    `git_get_repository_trust` is a read-only probe and routes to the peer
    host. `git_trust_repository` writes the peer user's global Git
    configuration (`safe.directory`) and tells Git to run hooks from a tree
    they do not own, so it is denied on both the desktop and CLI peer hosts.
    Its registry stance is `OperatorOnly`: the generated FE set deliberately
    omits it, because running it on the controller would write an exception
    for a path that only exists on the peer. A controller forwards it, receives
    the explicit refusal, and surfaces the probe's `manualCommand` instead.

16. **ProductControl commands follow the product host; presentation ACKs stay
    with the window.** `product_control_invoke` is a normal product mutation and
    routes to the selected peer only after `peer_mode_ping` advertises
    `product_control_v1`; an older peer fails explicitly and never falls back
    to the controller. Definitions that need a native provider or a live UI
    additionally declare `product_control_native_v1` or
    `product_control_presentation_v1`; the CLI host advertises neither and
    returns a typed unsupported result. `mark_openbitfun_control_surface_ready`,
    `mark_openbitfun_control_surface_unready`, and `report_openbitfun_control_result`
    describe or acknowledge the controller window's live Web UI and therefore
    remain `LOCAL_ONLY` in the frontend, Desktop host, and CLI host lists. A
    peer executes the same owner handler and uses its own attached presentation
    surface when a required runtime effect needs acknowledgement; an
    unavailable surface fails explicitly and never mutates the controller as a
    fallback.

17. **MiniApp Agent context files require an explicit peer capability.**
    `miniapp_agent_run` remains compatible with older peers when no context
    files are present. A run with non-empty `contextFiles` routes only after
    `peer_mode_ping` advertises `miniapp_agent_context_files_v1`; otherwise the
    controller fails before RPC. Never omit the files, fall back to a local
    Agent, or run the prompt without its declared context.

18. **WSL belongs to the selected Windows host.** `wsl_workspaces_v1` gates
    `ssh_list_wsl_distributions` and SSH profile requests with a `wsl` target
    before RPC. Missing capability means unsupported, including older Desktop
    and CLI peers. Discovery reports the host's OS availability; it must never
    inspect or execute the controller's WSL installation as a fallback.
