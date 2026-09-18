/**
 * Attach restores a host-owned view once. The durable session subscription
 * then follows Socket.IO notifications and replays by receive cursor. Explicit
 * runtime gaps or surface activation may request reconciliation; idle windows
 * do not repeatedly download snapshots.
 */

import {
  getActiveSurfaceScope,
  isSurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';
import { isSurfaceReconcileEnabled } from '@/infrastructure/peer-device/deviceSurfaceReconcile';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type {
  RuntimeProjectedAgenticEvent,
  SessionRuntimeEventSnapshot,
} from '@/infrastructure/api/service-api/AgentAPI';
import {
  beginRuntimeSessionAttachment,
  isRuntimeSessionProjectionStale,
  markRuntimeSessionProjectionStale,
  readRuntimeSessionProgress,
  subscribeRuntimeSessionEventGaps,
} from '@/infrastructure/peer-device/runtimeSessionEventGate';
import { createLogger } from '@/shared/utils/logger';
import {
  isBackendSessionActivelyProcessing,
} from '../../store/FlowChatStore';
import { stateMachineManager } from '../../state-machine';
import {
  SessionExecutionEvent,
  SessionExecutionState,
} from '../../state-machine/types';
import type { AnyFlowItem, DialogTurn, FlowToolItem, Session } from '../../types/flow-chat';
import { installLiveSessionInteractionMailbox } from '../liveSessionInteractionStore';
import { agenticEventListener } from '../AgenticEventListener';
import { pendingQueueManager } from './PendingQueueModule';
import type { FlowChatContext } from './types';

const log = createLogger('PeerSessionRefresh');

export const PEER_SESSION_STREAM_STALE_MS = 6000;

/**
 * A session can attach to the host Runtime projection once it has a usable
 * live shell on this surface.
 *
 * `historyState === 'ready'` is the hydrated-from-disk path. Locally created
 * sessions stay at `'new'` for their whole window — they never pass through
 * disk hydrate — and after a surface switch they are exactly the sessions
 * that missed DialogTurnStarted. Treating `'new'` as unready permanently
 * disables the only repair path: later chunks arrive against an idle machine
 * and are dropped, and the composer queues follow-up messages behind a turn
 * that the UI can no longer update.
 */
type AttachableSession = Pick<
  Session,
  'workspaceId' | 'isTransient' | 'isHistorical' | 'historyState'
> & { workspaceId: string };

export function isSessionProjectionAttachable(
  session: Pick<
    Session,
    'workspaceId' | 'isTransient' | 'isHistorical' | 'historyState'
  > | null | undefined,
): session is AttachableSession {
  const workspaceId = session?.workspaceId?.trim();
  return Boolean(
    session &&
    workspaceId &&
    !session.isTransient &&
    !session.isHistorical &&
    (session.historyState === 'ready' || session.historyState === 'new'),
  );
}

type RefreshRequester = (sessionId?: string) => void;
let installedRefreshRequester: RefreshRequester | null = null;

export function requestPeerSessionRefresh(sessionId?: string): void {
  if (!isSurfaceReconcileEnabled()) {
    return;
  }
  installedRefreshRequester?.(sessionId);
}

/** Cursor delivery is not acceptance — force the next attach to replay. */
export function requestRuntimeProjectionRepair(sessionId: string): void {
  markRuntimeSessionProjectionStale(getActiveSurfaceScope().surfaceId, sessionId);
  requestPeerSessionRefresh(sessionId);
}

function streamKey(
  roundId: string,
  item: Pick<AnyFlowItem, 'attemptId' | 'attemptIndex'>,
): string {
  if (item.attemptId) {
    return item.attemptId;
  }
  if (typeof item.attemptIndex === 'number' && Number.isFinite(item.attemptIndex)) {
    return `${roundId}:attempt:${item.attemptIndex}`;
  }
  return roundId;
}

function seedActiveTurnBuffers(
  context: FlowChatContext,
  sessionId: string,
  turn: DialogTurn,
): void {
  const contentBuffers = new Map<string, string>();
  const activeTextItems = new Map<string, string>();

  for (const round of turn.modelRounds) {
    for (const item of round.items) {
      if (item.type !== 'text' && item.type !== 'thinking') {
        continue;
      }
      const baseKey = streamKey(round.id, item);
      const key = item.type === 'thinking' ? `thinking_${baseKey}` : baseKey;
      contentBuffers.set(key, item.content || '');
      activeTextItems.set(key, item.id);
    }
  }

  context.contentBuffers.set(sessionId, contentBuffers);
  context.activeTextItems.set(sessionId, activeTextItems);
}

function isTerminalTurn(turn: DialogTurn | undefined): boolean {
  return turn?.status === 'completed' ||
    turn?.status === 'cancelled' ||
    turn?.status === 'error';
}

const JOURNAL_TERMINAL_TOOL_EVENTS = new Set([
  'Completed',
  'Failed',
  'Cancelled',
  'Rejected',
]);

function readJournalToolEvent(payload: Record<string, unknown>): {
  eventType: string;
  toolId: string;
} | null {
  const raw = payload.toolEvent ?? payload.tool_event;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const eventType = record.event_type ?? record.eventType;
  const toolId = record.tool_id ?? record.toolId;
  if (typeof eventType !== 'string' || !eventType || typeof toolId !== 'string' || !toolId) {
    return null;
  }
  return { eventType, toolId };
}

function collectTurnTools(turn: DialogTurn): FlowToolItem[] {
  const tools: FlowToolItem[] = [];
  const pushTool = (item: AnyFlowItem): void => {
    if (item.type === 'tool') {
      tools.push(item as FlowToolItem);
    }
  };
  for (const round of turn.modelRounds) {
    for (const item of round.items) {
      pushTool(item);
    }
    for (const attempt of round.attempts ?? []) {
      for (const item of attempt.items) {
        pushTool(item);
      }
    }
  }
  return tools;
}

function toolStatusMatchesJournal(status: FlowToolItem['status'], eventType: string): boolean {
  switch (eventType) {
    case 'Completed':
      return status === 'completed';
    case 'Failed':
      return status === 'error';
    case 'Cancelled':
      return status === 'cancelled' || status === 'confirmed';
    case 'Rejected':
      return status === 'rejected';
    default:
      return false;
  }
}

/** Host journal terminal tools must already be painted before we cover their cursors. */
export function runtimeProjectionCaughtUp(
  session: Session | undefined,
  snapshot: SessionRuntimeEventSnapshot,
): boolean {
  const turnId = snapshot.activeTurnId;
  if (!session || !turnId) {
    return false;
  }
  const turn = session.dialogTurns.find(candidate => candidate.id === turnId);
  if (!turn) {
    return false;
  }
  const tools = collectTurnTools(turn);
  for (const event of snapshot.events) {
    if (event.eventName !== 'agentic://tool-event') {
      continue;
    }
    const toolEvent = readJournalToolEvent(event.payload);
    if (!toolEvent || !JOURNAL_TERMINAL_TOOL_EVENTS.has(toolEvent.eventType)) {
      continue;
    }
    const item = tools.find(tool => (
      tool.id === toolEvent.toolId || tool.toolCall?.id === toolEvent.toolId
    ));
    if (!item || !toolStatusMatchesJournal(item.status, toolEvent.eventType)) {
      return false;
    }
  }
  return true;
}

/**
 * The Turn a delta ends in, read from the events themselves.
 *
 * A delta names no active Turn — it is a stream position, not a projection —
 * but the caught-up check is per Turn, so take the last one the events mention.
 */
function deltaActiveTurnId(events: RuntimeProjectedAgenticEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turnId = events[index]?.payload?.turnId;
    if (typeof turnId === 'string' && turnId) {
      return turnId;
    }
  }
  return undefined;
}

/**
 * Repair the projection by applying exactly what was missed.
 *
 * This is the ordinary way back to live. The Host knows what it sent after our
 * cursor, so a gap is answered rather than guessed at: nothing is cleared, no
 * state machine is reset, and no snapshot has to be judged against painted
 * content. Returns false when the caller must fall back to the snapshot path —
 * we have no cursor to be contiguous with, the Host cannot serve one, or the
 * delta applied but did not land.
 *
 * The attachment fence is what makes this safe against the live stream: events
 * arriving while the request is in flight are queued, then released in order
 * with the ones the delta already covered dropped by cursor.
 */
async function tryIncrementalCatchUp(
  context: FlowChatContext,
  surfaceScope: ReturnType<typeof getActiveSurfaceScope>,
  sessionId: string,
): Promise<boolean> {
  const applied = readRuntimeSessionProgress(surfaceScope.surfaceId, sessionId);
  if (!applied) {
    return false;
  }

  const attachment = beginRuntimeSessionAttachment(surfaceScope.surfaceId, sessionId);
  // A fence that is neither settled nor handed off holds this Session's live
  // events forever, which reads as the chat freezing and then flooding when
  // something else finally opens a read. Every exit below either settles it or
  // states which read inherits it, and the `finally` covers the rest.
  let fenceResolved = false;
  const handOffToSnapshotPath = (): boolean => {
    // The caller runs the snapshot path immediately when we return false, and
    // its own `beginRead` inherits the held events rather than racing them.
    fenceResolved = true;
    return false;
  };
  try {
    const backfill = await agentAPI.loadSessionEventBackfill(
      sessionId,
      applied.streamId,
      applied.cursor,
    );
    surfaceScope.assertCurrent('runtimeSessionBackfill');
    if (!attachment.isCurrent()) {
      // A newer read owns the fence and carries our queue with it.
      fenceResolved = true;
      return true;
    }
    if (backfill.kind !== 'delta') {
      return handOffToSnapshotPath();
    }

    for (const event of backfill.events) {
      surfaceScope.assertCurrent('applyRuntimeSessionBackfill');
      if (!agenticEventListener.dispatchExternal(event.eventName, event.payload)) {
        throw new Error('Agentic event listener is unavailable during Runtime catch-up');
      }
    }
    context.eventBatcher.flushNow();

    // Replaying events rebuilds a blocking interaction's card, but only the
    // Runtime mailbox rebinds it to something that can answer. Skipping this
    // left an AskUserQuestion on screen that no click could resolve after a
    // device switch.
    context.flowChatStore.reconcilePendingUserQuestions(
      sessionId,
      backfill.interactionSnapshot?.sessionId === sessionId
        ? backfill.interactionSnapshot.userQuestions
        : undefined,
    );

    // Delivery is still not acceptance. If the state machine dropped one of
    // these, escalate to the snapshot path in this same tick instead of
    // recording a cursor the screen does not actually reflect.
    const projectedSession = context.flowChatStore.getState().sessions.get(sessionId);
    const caughtUp = runtimeProjectionCaughtUp(projectedSession, {
      sessionId,
      streamId: backfill.streamId,
      cursor: backfill.cursor,
      activeTurnId: deltaActiveTurnId(backfill.events),
      events: backfill.events,
    });
    if (!caughtUp) {
      markRuntimeSessionProjectionStale(surfaceScope.surfaceId, sessionId);
      return handOffToSnapshotPath();
    }

    attachment.finish(
      { streamId: backfill.streamId, cursor: backfill.cursor },
      { projectionCaughtUp: true, events: backfill.events },
    );
    fenceResolved = true;
    log.debug('Runtime session projection caught up incrementally', {
      sessionId,
      from: applied.cursor,
      to: backfill.cursor,
      eventCount: backfill.events.length,
    });
    return true;
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.debug('Incremental catch-up failed; falling back to a snapshot', {
      sessionId,
      error,
    });
    return false;
  } finally {
    if (!fenceResolved) {
      // Release the held events rather than stranding them. On a superseded
      // read this is a no-op, which is why it is safe unconditionally.
      attachment.abort({ discard: !surfaceScope.isCurrent() });
    }
  }
}

async function alignStateMachineWithSnapshot(
  context: FlowChatContext,
  sessionId: string,
  backendState: string,
  latestTurnId?: string,
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  const latestTurn = latestTurnId
    ? session?.dialogTurns.find(turn => turn.id === latestTurnId)
    : session?.dialogTurns[session.dialogTurns.length - 1];

  if (
    isBackendSessionActivelyProcessing(backendState) &&
    latestTurn &&
    !isTerminalTurn(latestTurn)
  ) {
    stateMachineManager.reset(sessionId);
    seedActiveTurnBuffers(context, sessionId, latestTurn);
    await stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
      taskId: sessionId,
      dialogTurnId: latestTurn.id,
    });
    const latestRound = latestTurn.modelRounds[latestTurn.modelRounds.length - 1];
    if (latestRound) {
      await stateMachineManager.transition(sessionId, SessionExecutionEvent.MODEL_ROUND_START, {
        modelRoundId: latestRound.id,
      });
    }
    return;
  }

  context.contentBuffers.delete(sessionId);
  context.activeTextItems.delete(sessionId);
  stateMachineManager.reset(sessionId);
}

export function installPeerSessionRefresh(context: FlowChatContext): () => void {
  // Blocking interactions are Runtime mailboxes, so their event projection
  // must exist for the whole FlowChat lifetime rather than only while a card
  // component is mounted.
  installLiveSessionInteractionMailbox();
  let disposed = false;
  let inFlight = false;
  const queuedSessionIds = new Set<string | undefined>();
  let immediateTimer: ReturnType<typeof setTimeout> | null = null;
  let retrySubscription: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1000;
  function releaseSubscription(): void {
    if (retrySubscription !== null) { clearTimeout(retrySubscription); retrySubscription = null; }
  }
  function ensureSubscription(): void {
    if (disposed) return;
    const surface = getActiveSurfaceScope();
    const sessionId = context.flowChatStore.getState().activeSessionId;
    if (surface.surfaceId === 'local' || !sessionId) return;
    void context.flowChatStore.loadRelaySessionHistory(sessionId).then(() => {
      retryDelay = 1000;
    }).catch(error => {
      if (disposed || !surface.isCurrent()) return;
      log.warn('Session stream subscription deferred', { sessionId, error });
      if (retrySubscription !== null) return;
      retrySubscription = setTimeout(() => { retrySubscription = null; ensureSubscription(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    });
  }


  function enqueueFollowUpRefresh(sessionId?: string): void {
    queuedSessionIds.add(sessionId);
  }

  function drainFollowUpRefresh(): void {
    if (disposed || queuedSessionIds.size === 0) {
      return;
    }
    const next = queuedSessionIds.values().next().value;
    queuedSessionIds.delete(next);
    scheduleRefresh(next);
  }

  async function runRefresh(
    requestedSessionId?: string,
    staleOnly = false,
  ): Promise<void> {
    if (disposed || inFlight || !isSurfaceReconcileEnabled()) {
      if (inFlight) {
        enqueueFollowUpRefresh(requestedSessionId);
      }
      return;
    }
    // Peer history and live records share the durable subscription. Runtime
    // projection hydration remains only for the controller's local surface.
    if (getActiveSurfaceScope().surfaceId !== 'local') {
      ensureSubscription();
      return;
    }
    // Hidden only skips the 3s liveness poll. A named repair or first attach
    // must still run — otherwise a dropped ToolEnd stays frozen in the background.
    if (
      staleOnly &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    // A dead subscription is the strongest reason to reconcile, not a reason to
    // skip: bailing here meant a switch that tore the listener down disabled
    // the only path that could repair it, and the chat froze for good. Re-arm
    // and continue — the runtime cursor fence already covers the snapshot/live
    // race while the subscription is coming back up.
    if (!agenticEventListener.getIsListening()) {
      void context.ensureLiveSubscription?.();
    }

    const state = context.flowChatStore.getState();
    const sessionId = requestedSessionId || state.activeSessionId;
    // Attach is per (surface, session), not per the tab currently focused.
    // After a switch, every live session on this surface may have missed
    // DialogTurnStarted; dropped-event refresh requests name those sessions
    // explicitly even when they are not active.
    if (!sessionId) {
      return;
    }
    const session = state.sessions.get(sessionId);
    if (!isSessionProjectionAttachable(session)) {
      return;
    }
    ensureSubscription();
    pendingQueueManager.reconcileAgainstLiveTurns(
      sessionId,
      state.sessions.get(sessionId)?.dialogTurns ?? [],
    );

    const surfaceScope = getActiveSurfaceScope();
    const projectionStale = isRuntimeSessionProjectionStale(surfaceScope.surfaceId, sessionId);
    const machine = stateMachineManager.get(sessionId);
    const machineState = machine?.getCurrentState() ?? SessionExecutionState.IDLE;
    if (machineState === SessionExecutionState.FINISHING && !projectionStale) {
      return;
    }
    const lastUpdateTime = machine?.getContext().lastUpdateTime ?? 0;
    const forceRuntimeReplay =
      machineState === SessionExecutionState.IDLE ||
      machineState === SessionExecutionState.ERROR;
    const streamIsStale = Date.now() - lastUpdateTime >= PEER_SESSION_STREAM_STALE_MS;
    if (staleOnly && !forceRuntimeReplay && !streamIsStale && !projectionStale) {
      return;
    }
    // Repair only what is actually broken. This path installs an event fence
    // and makes a Host round trip, so running it on an ordinary lifecycle
    // refresh held the live stream behind a relay RPC — the model's reply sat
    // in the fence queue waiting for a request that had nothing to repair
    // (regression: send-to-first-token latency, and the fence churn that left
    // an interactive card unanswerable after a device switch).
    //
    // A gap/refused event precedes the delivered cursor. A suffix starting
    // after that cursor cannot repair it; rebuild from the journal prefix.
    // `forceRuntimeReplay` is deliberately excluded: an idle or errored
    // machine has no live projection to continue, and wants the snapshot.
    const canRepairIncrementally =
      !forceRuntimeReplay && !projectionStale && streamIsStale;
    if (canRepairIncrementally) {
      inFlight = true;
      try {
        // Ask what was missed before rebuilding anything. A repair that
        // applies the exact events after our cursor cannot drop content, so
        // the snapshot path below is the fallback for a cursor the Host can no
        // longer serve — not the normal way back to live.
        if (await tryIncrementalCatchUp(context, surfaceScope, sessionId)) {
          return;
        }
      } catch (error) {
        if (isSurfaceChangedError(error)) {
          return;
        }
        throw error;
      } finally {
        inFlight = false;
      }
    }

    context.eventBatcher.flushNow();
    const machineVersion = machine?.getContext().version ?? 0;
    const attachment = beginRuntimeSessionAttachment(surfaceScope.surfaceId, sessionId);
    let attachmentFinished = false;

    inFlight = true;
    try {
      const result = await context.flowChatStore.refreshPeerSessionSnapshot(
        sessionId,
        {
          // A background session on this surface still owns its projection.
          // Requiring the focused tab aborted the dropped-event repair for
          // every non-active running chat after a multi-session switch.
          requireActiveSession: false,
          shouldApply: () => {
            if (!isSurfaceReconcileEnabled()) {
              return false;
            }
            const currentMachine = stateMachineManager.get(sessionId);
            return (currentMachine?.getContext().version ?? 0) === machineVersion;
          },
          shouldReplayRuntimeSnapshot: snapshot =>
            forceRuntimeReplay || attachment.requiresReplay(snapshot),
        },
      );
      surfaceScope.assertCurrent('attachRuntimeSession');
      if (!attachment.isCurrent()) {
        attachmentFinished = true;
        return;
      }
      const restoredSession = context.flowChatStore.getState().sessions.get(sessionId);
      if (restoredSession) {
        pendingQueueManager.reconcileAgainstLiveTurns(
          sessionId,
          restoredSession.dialogTurns,
        );
      }

      if (result.runtimeEventSnapshot) {
        const snapshot = result.runtimeEventSnapshot;
        const alreadyCurrent = result.runtimeEventReplayRequired === false
          && runtimeProjectionCaughtUp(restoredSession, snapshot);
        if (alreadyCurrent) {
          // Runtime cursor health and blocking-interaction health are separate
          // projections. A live event can win the restore race after the
          // persisted merge, leaving an AskUserQuestion card visible but
          // unbound/disabled even though every journal event is already
          // painted. Always reconcile the Runtime mailbox before covering the
          // cursor.
          context.flowChatStore.reconcilePendingUserQuestions(
            sessionId,
            result.pendingUserQuestions,
          );
          attachment.finish({
            streamId: snapshot.streamId,
            cursor: snapshot.cursor,
          }, { projectionCaughtUp: true, events: snapshot.events });
          attachmentFinished = true;
          log.debug('Runtime session projection already current', {
            sessionId,
            cursor: snapshot.cursor,
          });
          return;
        }

        // Establish an empty current-Turn base before replay. The journal is
        // authoritative for everything after DialogTurnStarted, so no
        // UI-written partial checkpoint is allowed to overlap it.
        // Only this Session is fenced. Other Sessions may have accumulated
        // text/tool events during the read; publish them instead of erasing them.
        context.eventBatcher.flushNow();
        context.contentBuffers.delete(sessionId);
        context.activeTextItems.delete(sessionId);
        const replayTurnId = snapshot.activeTurnId ?? result.latestTurnId;
        if (replayTurnId) {
          context.flowChatStore.prepareRuntimeTurnReplay?.(sessionId, replayTurnId);
        }
        stateMachineManager.reset(sessionId);
        await alignStateMachineWithSnapshot(
          context,
          sessionId,
          result.backendState,
          snapshot.activeTurnId ?? result.latestTurnId,
        );
        if (!attachment.isCurrent()) {
          attachmentFinished = true;
          return;
        }

        for (const event of snapshot.events) {
          surfaceScope.assertCurrent('replayRuntimeSessionProjection');
          if (!agenticEventListener.dispatchExternal(event.eventName, event.payload)) {
            throw new Error('Agentic event listener is unavailable during Runtime replay');
          }
        }
        context.eventBatcher.flushNow();
        context.flowChatStore.reconcilePendingUserQuestions(
          sessionId,
          result.pendingUserQuestions,
        );
        await alignStateMachineWithSnapshot(
          context,
          sessionId,
          result.backendState,
          snapshot.activeTurnId ?? result.latestTurnId,
        );
        surfaceScope.assertCurrent('finishRuntimeSessionAttachment');
        if (!attachment.isCurrent()) {
          attachmentFinished = true;
          return;
        }
        const projectedSession = context.flowChatStore.getState().sessions.get(sessionId);
        const projectionCaughtUp = runtimeProjectionCaughtUp(projectedSession, snapshot);
        attachment.finish({
          streamId: snapshot.streamId,
          cursor: snapshot.cursor,
        }, { projectionCaughtUp, events: snapshot.events });
        attachmentFinished = true;
        if (!projectionCaughtUp) {
          markRuntimeSessionProjectionStale(surfaceScope.surfaceId, sessionId);
        }
        log.debug('Runtime session projection attached', {
          sessionId,
          backendState: result.backendState,
          cursor: snapshot.cursor,
          eventCount: snapshot.events.length,
          projectionCaughtUp,
        });
        return;
      }

      // Older hosts have no cursor contract. Release their queued live events
      // and retain the existing persisted-snapshot reconciliation fallback.
      attachment.abort();
      attachmentFinished = true;
      // `interactionSnapshot` was introduced independently of the Runtime
      // journal. Apply it even when the persisted Turn merge lost a race; its
      // own monotonic revision fence makes this safe and keeps the form bound
      // to the owner mailbox.
      context.flowChatStore.reconcilePendingUserQuestions(
        sessionId,
        result.pendingUserQuestions,
      );
      if (!result.applied) {
        // A snapshot that changed nothing — or that was refused because it
        // would have dropped projected content — still reports whether the
        // host is executing. After a device-surface switch the rebuilt
        // projection has no state machine, so an executing turn would render
        // as static history and later chunks would be dropped. Re-attach on
        // that narrow case only: while a turn really is streaming the machine
        // is already processing, so this cannot churn it every tick.
        const machine = stateMachineManager.get(sessionId);
        const machineIsIdle =
          (machine?.getCurrentState() ?? SessionExecutionState.IDLE)
            === SessionExecutionState.IDLE;
        if (machineIsIdle && isBackendSessionActivelyProcessing(result.backendState)) {
          await alignStateMachineWithSnapshot(
            context,
            sessionId,
            result.backendState,
            result.latestTurnId,
          );
          log.debug('Re-attached an executing session after a surface switch', {
            sessionId,
            backendState: result.backendState,
          });
        }
        return;
      }
      await alignStateMachineWithSnapshot(
        context,
        sessionId,
        result.backendState,
        result.latestTurnId,
      );
      log.debug('Peer session snapshot reconciled', {
        sessionId,
        backendState: result.backendState,
        latestTurnId: result.latestTurnId,
      });
    } catch (error) {
      if (!attachmentFinished && attachment.isCurrent()) {
        attachment.abort({ discard: !surfaceScope.isCurrent() });
        if (surfaceScope.isCurrent()) {
          markRuntimeSessionProjectionStale(surfaceScope.surfaceId, sessionId);
        }
        attachmentFinished = true;
      }
      if (isSurfaceChangedError(error)) {
        // The snapshot belongs to a device this window stopped rendering. Its
        // own container keeps the projection; the surface now on screen
        // reconciles itself on the next tick.
        log.debug('Discarded a snapshot for a device surface we left', { sessionId });
        return;
      }
      // Realtime DeviceEvents remain usable when a background refresh fails.
      // The next interval or gap-triggered request retries without forcing an
      // auto-exit from Peer Mode.
      log.warn('Peer session snapshot refresh failed', { sessionId, error });
    } finally {
      if (!attachmentFinished && attachment.isCurrent()) {
        attachment.abort({ discard: !surfaceScope.isCurrent() });
        if (surfaceScope.isCurrent()) {
          markRuntimeSessionProjectionStale(surfaceScope.surfaceId, sessionId);
        }
      }
      inFlight = false;
      ensureSubscription();
      drainFollowUpRefresh();
    }
  }

  function scheduleRefresh(sessionId?: string): void {
    if (disposed) {
      return;
    }
    // Do not replace a pending attach with a later request: two sessions
    // that drop events in the same tick must both be repaired.
    if (inFlight || immediateTimer !== null) {
      enqueueFollowUpRefresh(sessionId);
      return;
    }
    immediateTimer = setTimeout(() => {
      immediateTimer = null;
      void runRefresh(sessionId);
    }, 0);
  }

  installedRefreshRequester = scheduleRefresh;
  const unsubscribeSourceGap = remoteConnectAPI.onSessionGap(event => scheduleRefresh(event.sessionId));

  const unsubscribeActiveSession = context.flowChatStore.subscribeSelector(
    state => {
      const sessionId = state.activeSessionId;
      const session = sessionId ? state.sessions.get(sessionId) : undefined;
      return JSON.stringify([
        sessionId ?? '',
        session?.historyState ?? '',
        session?.workspaceId ?? '',
        session?.isTransient === true,
        session?.isHistorical === true,
      ]);
    },
    () => scheduleRefresh(),
  );
  // Durable Socket.IO notifications and after-sequence recovery replace the
  // previous three-second snapshot poll. Attach still reads the host once.
  const unsubscribeRuntimeGaps = subscribeRuntimeSessionEventGaps(
    (surfaceId, sessionId) => {
      if (getActiveSurfaceScope().surfaceId === surfaceId) {
        scheduleRefresh(sessionId);
      }
    },
  );

  const handlePeerModeChanged = (): void => { releaseSubscription(); scheduleRefresh(); };
  const handleVisibilityChanged = (): void => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      scheduleRefresh();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('peer-mode:changed', handlePeerModeChanged);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChanged);
  }

  scheduleRefresh();

  return () => {
    disposed = true;
    if (installedRefreshRequester === scheduleRefresh) {
      installedRefreshRequester = null;
    }
    if (immediateTimer !== null) {
      clearTimeout(immediateTimer);
    }
    releaseSubscription();
    unsubscribeActiveSession();
    unsubscribeRuntimeGaps();
    unsubscribeSourceGap();
    if (typeof window !== 'undefined') {
      window.removeEventListener('peer-mode:changed', handlePeerModeChanged);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChanged);
    }
  };
}
