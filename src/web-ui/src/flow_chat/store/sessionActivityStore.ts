import type { SessionActivitySummary, SessionLastTurn } from '@/shared/types/session-history';
import { getActiveSurfaceId, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { readBackgroundDelivery, shouldDeliverBackgroundCompletion } from '../utils/backgroundDelivery';

export interface ActivityRead {
  surfaceId: DeviceSurfaceId;
  eventVersion: number;
  sequence: number;
}

interface Entry {
  summary?: SessionActivitySummary;
  eventVersion: number;
  readSequence: number;
  checkedAt: number;
  stale: boolean;
  acknowledged?: { turnId: string; status?: SessionLastTurn['status']; executionGeneration?: number; recoveryPending?: boolean };
  position?: { streamId: string; cursor: number };
}

const blank = (sessionId: string): SessionActivitySummary => ({
  sessionId, execution: 'idle', pendingApprovals: 0, pendingQuestions: 0,
});

/** Read projection only. Runtime state machines and transcript ownership stay unchanged. */
export class SessionActivityStore {
  private surfaces = new Map<DeviceSurfaceId, Map<string, Entry>>();
  private listeners = new Set<(surfaceId: DeviceSurfaceId, sessionId: string) => void>();
  private eventVersion = 0;
  private readSequence = 0;

  private entries(surfaceId: DeviceSurfaceId): Map<string, Entry> {
    let entries = this.surfaces.get(surfaceId);
    if (!entries) this.surfaces.set(surfaceId, entries = new Map());
    return entries;
  }

  get(sessionId: string, surfaceId = getActiveSurfaceId()): Readonly<Entry> | undefined {
    return this.surfaces.get(surfaceId)?.get(sessionId);
  }

  subscribe(listener: (surfaceId: DeviceSurfaceId, sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(surfaceId: DeviceSurfaceId, sessionId: string): void {
    for (const listener of this.listeners) listener(surfaceId, sessionId);
  }

  beginRead(surfaceId = getActiveSurfaceId()): ActivityRead {
    return { surfaceId, eventVersion: this.eventVersion, sequence: ++this.readSequence };
  }

  applyRead(read: ActivityRead, summaries: readonly SessionActivitySummary[]): void {
    const entries = this.entries(read.surfaceId);
    for (const incoming of summaries) {
      let summary = incoming;
      const previous = entries.get(summary.sessionId);
      // An event/local submission/receipt observed after request dispatch wins.
      // Reads are ordered independently so a slower previous read cannot regress it.
      if (previous && (previous.eventVersion > read.eventVersion || previous.readSequence > read.sequence)) continue;
      const previousTurn = previous?.summary?.lastTurn;
      if (summary.lastTurn && summary.lastTurn.recoveryPending === undefined && previousTurn
        && previousTurn.turnId === summary.lastTurn.turnId && previousTurn.status === summary.lastTurn.status
        && (previousTurn.executionGeneration ?? 0) === (summary.lastTurn.executionGeneration ?? 0)) {
        summary = { ...summary, lastTurn: { ...summary.lastTurn, recoveryPending: previousTurn.recoveryPending } };
      }
      const acknowledged = previous?.acknowledged;
      const receipt = summary.unreadTurn ?? summary.lastTurn;
      const alreadyRead = acknowledged && receipt?.turnId === acknowledged.turnId
        && (receipt.executionGeneration ?? 0) === (acknowledged.executionGeneration ?? 0)
        && (acknowledged.status === undefined || receipt.status === acknowledged.status)
        && (acknowledged.recoveryPending === undefined || receipt.recoveryPending === undefined
          || receipt.recoveryPending === acknowledged.recoveryPending)
        && receipt.status !== 'inprogress' && (summary.unreadTurn !== undefined || summary.execution !== 'running');
      entries.set(summary.sessionId, {
        ...previous, summary: alreadyRead ? { ...summary, unreadCompletion: undefined } : summary,
        acknowledged: alreadyRead ? acknowledged : undefined, eventVersion: previous?.eventVersion ?? 0,
        readSequence: read.sequence, checkedAt: Date.now(), stale: false,
      });
      this.notify(read.surfaceId, summary.sessionId);
    }
  }

  invalidate(sessionId: string, surfaceId = getActiveSurfaceId()): void {
    const previous = this.get(sessionId, surfaceId);
    this.entries(surfaceId).set(sessionId, {
      ...previous, eventVersion: ++this.eventVersion, readSequence: previous?.readSequence ?? 0,
      checkedAt: previous?.checkedAt ?? 0, stale: true,
    });
    this.notify(surfaceId, sessionId);
  }

  /** A visible, settled result may be acknowledged before its persistence RPC returns. */
  acknowledge(sessionId: string, turnId: string, executionGeneration?: number, recoveryPending?: boolean): void {
    const previous = this.get(sessionId);
    const summary = previous?.summary;
    const receipt = summary?.unreadTurn ?? summary?.lastTurn;
    if (receipt && (receipt.turnId !== turnId
      || (receipt.executionGeneration ?? 0) !== (executionGeneration ?? 0)
      || (receipt.recoveryPending !== undefined && recoveryPending !== undefined
        && receipt.recoveryPending !== recoveryPending))) return;
    this.entries(getActiveSurfaceId()).set(sessionId, {
      ...previous, eventVersion: ++this.eventVersion, readSequence: previous?.readSequence ?? 0,
      checkedAt: previous?.checkedAt ?? 0, stale: previous?.stale ?? false,
      acknowledged: { turnId, status: receipt?.status, executionGeneration,
        recoveryPending: recoveryPending ?? receipt?.recoveryPending },
      summary: summary ? { ...summary, unreadCompletion: undefined } : undefined,
    });
    this.notify(getActiveSurfaceId(), sessionId);
  }

  observe(surfaceId: DeviceSurfaceId, eventName: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    if (eventName === 'agentic://tool-event') {
      const tool = event.toolEvent as Record<string, unknown> | undefined;
      if (tool?.tool_name !== 'AskUserQuestion' && tool?.event_type !== 'ConfirmationNeeded') return;
      if (tool?.event_type === 'Progress') return;
    }
    const sessionId = event.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const previous = this.get(sessionId, surfaceId);
    const streamId = event.__openbitfunRuntimeStreamId;
    const cursor = event.__openbitfunRuntimeEventCursor;
    const position = typeof streamId === 'string' && typeof cursor === 'number'
      ? { streamId, cursor } : undefined;
    if (position && previous?.position?.streamId === position.streamId
      && previous.position.cursor >= position.cursor) return;
    // Semantic no-ops still advance ordering, without invalidation or renders.
    if (position && previous) this.entries(surfaceId).set(sessionId, { ...previous, position });

    if (eventName === 'agentic://session-deleted') {
      // Keep a tombstone until the surface is released: an outstanding read
      // must not revive a deleted session's status.
      this.entries(surfaceId).set(sessionId, {
        eventVersion: ++this.eventVersion, readSequence: previous?.readSequence ?? 0,
        checkedAt: Date.now(), stale: false, position,
      });
      this.notify(surfaceId, sessionId);
      return;
    }
    let summary = previous?.summary ?? blank(sessionId);
    const turnId = typeof event.turnId === 'string' ? event.turnId : undefined;
    const delivery = readBackgroundDelivery(event.backgroundDelivery ?? event.background_delivery, turnId ?? '');
    const generation = typeof event.executionGeneration === 'number' ? event.executionGeneration : delivery ? delivery.executionGeneration ?? 0 : undefined;
    if (generation !== undefined && summary.lastTurn?.turnId === turnId
      && (summary.lastTurn?.executionGeneration ?? -1) > generation) return;
    const starting = eventName === 'agentic://dialog-turn-started' || eventName === 'agentic://dialog-turn-recovered';
    const settling = ['agentic://dialog-turn-completed', 'agentic://dialog-turn-failed',
      'agentic://dialog-turn-cancelled', 'agentic://dialog-turn-interrupted'].includes(eventName);
    let newResult = false;
    if (starting) {
      summary = {
        ...summary, execution: 'running', activeTurnId: turnId, pendingApprovals: 0, pendingQuestions: 0,
        unreadTurn: summary.unreadCompletion ? summary.unreadTurn ?? summary.lastTurn : undefined,
        lastTurn: turnId ? {
          turnId, turnIndex: typeof event.turnIndex === 'number' ? event.turnIndex : summary.lastTurn?.turnIndex ?? 0,
          status: 'inprogress', recoveryPending: false, executionGeneration: generation ?? (summary.lastTurn?.turnId === turnId
            ? summary.lastTurn?.executionGeneration : undefined),
        } : summary.lastTurn,
      };
    } else if (settling) {
      if (summary.activeTurnId && turnId && summary.activeTurnId !== turnId) return;
      const outcome = eventName.endsWith('-completed') ? 'completed'
        : eventName.endsWith('-failed') ? 'error' : 'interrupted';
      const recoveryPending = eventName === 'agentic://dialog-turn-interrupted';
      const sameOutcome = !summary.activeTurnId && summary.lastTurn?.turnId === turnId
        && (generation === undefined || summary.lastTurn?.executionGeneration === generation)
        && summary.lastTurn?.status === (outcome === 'interrupted' ? 'cancelled' : outcome);
      if (sameOutcome && summary.lastTurn?.recoveryPending === recoveryPending) return;
      // Learning an optional recovery fact from a replay is not a new result.
      // A known paused -> cancelled transition is, even within one generation.
      newResult = (!sameOutcome || summary.lastTurn?.recoveryPending !== undefined)
        && (outcome !== 'completed' || shouldDeliverBackgroundCompletion(event));
      summary = {
        ...summary, execution: outcome === 'error' ? 'error' : 'idle', activeTurnId: undefined,
        pendingApprovals: 0, pendingQuestions: 0, unreadCompletion: newResult ? outcome : summary.unreadCompletion,
        unreadTurn: newResult ? {
          turnId: turnId ?? '', turnIndex: typeof event.turnIndex === 'number' ? event.turnIndex : summary.lastTurn?.turnIndex ?? 0,
          status: outcome === 'interrupted' ? 'cancelled' : outcome, recoveryPending,
          executionGeneration: generation,
        } : summary.unreadTurn,
        lastTurn: turnId ? {
          turnId, turnIndex: typeof event.turnIndex === 'number' ? event.turnIndex : summary.lastTurn?.turnIndex ?? 0,
          status: outcome === 'interrupted' ? 'cancelled' : outcome,
          recoveryPending,
          executionGeneration: generation ?? (summary.lastTurn?.turnId === turnId ? summary.lastTurn?.executionGeneration : undefined),
        } : summary.lastTurn,
      };
    } else if (eventName === 'agentic://session-state-changed') {
      const state = typeof event.newState === 'string' ? event.newState.toLowerCase() : '';
      if (state === 'processing' && summary.execution === 'running') return;
      if (state === 'idle' && previous?.summary?.execution === 'idle') return;
      if (state === 'processing') summary = { ...summary, execution: 'running' };
      // Idle carries no Turn identity/outcome. Invalidate it for a batch read
      // instead of allowing a delayed idle event to settle a newer Turn.
    } else if (eventName !== 'agentic://session-history-changed' && eventName !== 'agentic://tool-event') {
      return;
    }
    this.entries(surfaceId).set(sessionId, {
      summary, eventVersion: ++this.eventVersion, readSequence: previous?.readSequence ?? 0,
      checkedAt: previous?.checkedAt ?? 0, stale: true, position: position ?? previous?.position,
      acknowledged: starting || newResult ? undefined : previous?.acknowledged,
    });
    this.notify(surfaceId, sessionId);
  }
}

export const sessionActivityStore = new SessionActivityStore();
