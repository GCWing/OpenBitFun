import { describe, expect, it } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { SessionActivitySummary } from '@/shared/types/session-history';
import { SessionActivityStore } from './sessionActivityStore';

const summary = (execution = 'idle', id = 'session'): SessionActivitySummary => ({
  sessionId: id, execution, pendingApprovals: 0, pendingQuestions: 0,
});

describe('session activity read projection', () => {
  it('keeps a prior unread result across a newer quiet run and acknowledges its original identity', () => {
    activateSurface('local');
    const store = new SessionActivityStore();
    store.observe('local', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'nine' });
    store.observe('local', 'agentic://dialog-turn-started', { sessionId: 'session', turnId: 'eleven' });
    store.observe('local', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'eleven', backgroundDelivery: {
      schemaVersion: 1, source: 'scheduled_job', taskId: 'monitor', runId: 'eleven', policy: 'conditional', disposition: 'quiet', resolvedAtMs: 1,
    } });
    expect(store.get('session')?.summary).toMatchObject({ unreadCompletion: 'completed', unreadTurn: { turnId: 'nine' }, lastTurn: { turnId: 'eleven' } });
    store.acknowledge('session', 'nine');
    expect(store.get('session')?.summary?.unreadCompletion).toBeUndefined();
    store.applyRead(store.beginRead(), [{ ...summary(), unreadCompletion: 'completed', unreadTurn: { turnId: 'nine', turnIndex: 0, status: 'completed' }, lastTurn: { turnId: 'eleven', turnIndex: 1, status: 'completed' } }]);
    expect(store.get('session')?.summary?.unreadCompletion).toBeUndefined();
    store.observe('local', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'thirteen' });
    store.acknowledge('session', 'nine');
    expect(store.get('session')?.summary?.unreadTurn?.turnId).toBe('thirteen');
    expect(store.get('session')?.summary?.unreadCompletion).toBe('completed');
  });
  it('can bootstrap an unopened session without constructing transcript state', () => {
    const store = new SessionActivityStore();
    store.applyRead(store.beginRead('host'), [summary('running')]);
    expect(store.get('session', 'host')?.summary?.execution).toBe('running');
  });

  it('does not let a startup snapshot overwrite a newer background event', () => {
    const store = new SessionActivityStore();
    const read = store.beginRead('host');
    store.observe('host', 'agentic://dialog-turn-started', { sessionId: 'session', turnId: 'new' });
    store.applyRead(read, [summary()]);
    expect(store.get('session', 'host')?.summary?.activeTurnId).toBe('new');
    expect(store.get('session', 'host')?.stale).toBe(true);
  });

  it('orders concurrent reads and keeps identical ids on different hosts isolated', () => {
    const store = new SessionActivityStore();
    const older = store.beginRead('peer');
    store.applyRead(store.beginRead('peer'), [summary('error')]);
    store.applyRead(older, [summary('running')]);
    store.applyRead(store.beginRead('local'), [summary('idle')]);
    expect(store.get('session', 'peer')?.summary?.execution).toBe('error');
    expect(store.get('session', 'local')?.summary?.execution).toBe('idle');
  });

  it('retains a terminal outcome received while its host is in the background', () => {
    const store = new SessionActivityStore();
    store.observe('peer', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'done' });
    expect(store.get('session', 'peer')?.summary).toMatchObject({
      unreadCompletion: 'completed', lastTurn: { turnId: 'done', status: 'completed' },
    });
  });

  it('rejects stale terminal events by turn identity and ordered event position', () => {
    const store = new SessionActivityStore();
    store.observe('host', 'agentic://dialog-turn-started', {
      sessionId: 'session', turnId: 'new', __openbitfunRuntimeStreamId: 'runtime', __openbitfunRuntimeEventCursor: 20,
    });
    store.observe('host', 'agentic://dialog-turn-completed', {
      sessionId: 'session', turnId: 'old', __openbitfunRuntimeStreamId: 'runtime', __openbitfunRuntimeEventCursor: 19,
    });
    store.observe('host', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'old' });
    expect(store.get('session', 'host')?.summary?.execution).toBe('running');
  });

  it('does not reconcile every phase or tool-progress event during streaming', () => {
    const store = new SessionActivityStore();
    store.applyRead(store.beginRead('host'), [summary('running')]);
    const before = store.get('session', 'host');
    for (let i = 0; i < 100; i++) {
      store.observe('host', 'agentic://session-state-changed', { sessionId: 'session', newState: 'processing' });
      store.observe('host', 'agentic://tool-event', { sessionId: 'session', toolEvent: { event_type: 'Progress' } });
    }
    expect(store.get('session', 'host')).toBe(before);
  });

  it('uses no-op phase events as ordering fences without invalidating the snapshot', () => {
    const store = new SessionActivityStore();
    store.applyRead(store.beginRead('host'), [summary('running')]);
    store.observe('host', 'agentic://session-state-changed', {
      sessionId: 'session', newState: 'processing', __openbitfunRuntimeStreamId: 'runtime', __openbitfunRuntimeEventCursor: 30,
    });
    store.observe('host', 'agentic://dialog-turn-completed', {
      sessionId: 'session', turnId: 'old', __openbitfunRuntimeStreamId: 'runtime', __openbitfunRuntimeEventCursor: 25,
    });
    expect(store.get('session', 'host')?.summary?.execution).toBe('running');
    expect(store.get('session', 'host')?.stale).toBe(false);
  });

  it('keeps an acknowledged result read while its persistence request is in flight', () => {
    activateSurface('receipts');
    const store = new SessionActivityStore();
    const result = { ...summary(), lastTurn: { turnId: 'done', turnIndex: 0, status: 'completed' as const, endTime: 10 }, unreadCompletion: 'completed' as const };
    store.applyRead(store.beginRead(), [result]);
    store.acknowledge('session', 'done');
    store.applyRead(store.beginRead(), [result]);
    expect(store.get('session')?.summary?.unreadCompletion).toBeUndefined();
    store.applyRead(store.beginRead(), [{ ...result, lastTurn: { ...result.lastTurn, endTime: 20, executionGeneration: 1 } }]);
    expect(store.get('session')?.summary?.unreadCompletion).toBe('completed');
  });

  it('does not let an outstanding read revive a deleted row', () => {
    const store = new SessionActivityStore();
    const read = store.beginRead('host');
    store.observe('host', 'agentic://session-deleted', { sessionId: 'session' });
    store.applyRead(read, [summary('running')]);
    expect(store.get('session', 'host')?.summary).toBeUndefined();
  });

  it('keeps recovered background turns running and rejects older generation interruptions', () => {
    const store = new SessionActivityStore();
    store.observe('host', 'agentic://dialog-turn-interrupted', { sessionId: 'session', turnId: 'turn', executionGeneration: 0 });
    store.observe('host', 'agentic://dialog-turn-recovered', { sessionId: 'session', turnId: 'turn', executionGeneration: 1 });
    store.observe('host', 'agentic://dialog-turn-interrupted', { sessionId: 'session', turnId: 'turn', executionGeneration: 0 });
    expect(store.get('session', 'host')?.summary).toMatchObject({ execution: 'running', lastTurn: { executionGeneration: 1 } });
    store.observe('host', 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'turn' });
    expect(store.get('session', 'host')?.summary).toMatchObject({ execution: 'idle', lastTurn: { status: 'completed', executionGeneration: 1 } });
  });

  it('never clears a summary for a newer generation from an older receipt', () => {
    activateSurface('stale-generation-receipt');
    const store = new SessionActivityStore();
    store.observe('stale-generation-receipt', 'agentic://dialog-turn-interrupted', { sessionId: 'session', turnId: 'turn', executionGeneration: 2 });
    store.acknowledge('session', 'turn', 1);
    expect(store.get('session')?.summary?.unreadCompletion).toBe('interrupted');
  });

  it('announces a newer generation even when its start event was missed', () => {
    activateSurface('missed-recovery-start');
    const store = new SessionActivityStore();
    store.observe('missed-recovery-start', 'agentic://dialog-turn-completed', {
      sessionId: 'session', turnId: 'turn', executionGeneration: 1,
    });
    store.acknowledge('session', 'turn', 1, false);
    store.observe('missed-recovery-start', 'agentic://dialog-turn-completed', {
      sessionId: 'session', turnId: 'turn', executionGeneration: 2,
    });
    expect(store.get('session')?.summary).toMatchObject({
      unreadCompletion: 'completed', lastTurn: { executionGeneration: 2 },
    });
  });

  it('does not apply an acknowledged outcome to a different settled outcome', () => {
    activateSurface('changed-outcome');
    const store = new SessionActivityStore();
    store.applyRead(store.beginRead(), [{ ...summary(), unreadCompletion: 'interrupted',
      lastTurn: { turnId: 'turn', turnIndex: 0, status: 'cancelled', recoveryPending: false } }]);
    store.acknowledge('session', 'turn', undefined, false);
    store.applyRead(store.beginRead(), [{ ...summary(), unreadCompletion: 'error',
      lastTurn: { turnId: 'turn', turnIndex: 0, status: 'error', recoveryPending: false } }]);
    expect(store.get('session')?.summary?.unreadCompletion).toBe('error');
  });

  it('preserves a known recovery fact when an older host omits the optional field', () => {
    activateSurface('legacy-recovery-summary');
    const store = new SessionActivityStore();
    store.observe('legacy-recovery-summary', 'agentic://dialog-turn-interrupted', {
      sessionId: 'session', turnId: 'turn', executionGeneration: 1,
    });
    store.acknowledge('session', 'turn', 1, true);
    store.applyRead(store.beginRead(), [{ ...summary(), unreadCompletion: 'interrupted',
      lastTurn: { turnId: 'turn', turnIndex: 0, status: 'cancelled', executionGeneration: 1 } }]);
    expect(store.get('session')?.summary?.lastTurn?.recoveryPending).toBe(true);
    expect(store.get('session')?.summary?.unreadCompletion).toBeUndefined();
  });

  it('does not let a receipt for a pause acknowledge its later cancellation', () => {
    activateSurface('pause-receipt');
    const store = new SessionActivityStore();
    store.observe('pause-receipt', 'agentic://dialog-turn-interrupted', {
      sessionId: 'session', turnId: 'turn', executionGeneration: 1,
    });
    store.observe('pause-receipt', 'agentic://dialog-turn-cancelled', { sessionId: 'session', turnId: 'turn' });
    store.acknowledge('session', 'turn', 1, true);
    expect(store.get('session')?.summary?.lastTurn?.recoveryPending).toBe(false);
    expect(store.get('session')?.summary?.unreadCompletion).toBe('interrupted');
  });

  it.each(['error', 'completed'] as const)('does not revive an acknowledged legacy %s from a replay', (outcome) => {
    activateSurface(`legacy-replay-${outcome}`);
    const store = new SessionActivityStore();
    store.applyRead(store.beginRead(), [{ ...summary(), unreadCompletion: outcome,
      lastTurn: { turnId: 'turn', turnIndex: 0, status: outcome } }]);
    store.acknowledge('session', 'turn', undefined, false);
    store.observe(`legacy-replay-${outcome}`, outcome === 'error'
      ? 'agentic://dialog-turn-failed' : 'agentic://dialog-turn-completed', { sessionId: 'session', turnId: 'turn' });
    expect(store.get('session')?.summary?.unreadCompletion).toBeUndefined();
    expect(store.get('session')?.summary?.lastTurn?.recoveryPending).toBe(false);
  });
  it('ignores an earlier quiet generation after recovery and accepts legacy zero-generation receipts', () => {
    activateSurface('local');
    const store = new SessionActivityStore();
    store.observe('local', 'agentic://dialog-turn-started', { sessionId: 's', turnId: 'run' });
    store.observe('local', 'agentic://dialog-turn-recovered', { sessionId: 's', turnId: 'run', executionGeneration: 1 });
    store.observe('local', 'agentic://dialog-turn-completed', { sessionId: 's', turnId: 'run', backgroundDelivery: { schemaVersion: 1, source: 'scheduled_job', taskId: 'task', runId: 'run', policy: 'conditional', disposition: 'quiet', executionGeneration: 0, resolvedAtMs: 1 } });
    expect(store.get('s', 'local')?.summary?.execution).toBe('running');
    expect(store.get('s', 'local')?.summary?.lastTurn?.executionGeneration).toBe(1);
    store.observe('local', 'agentic://dialog-turn-completed', { sessionId: 'legacy', turnId: 'zero', executionGeneration: 0 });
    store.acknowledge('legacy', 'zero');
    expect(store.get('legacy', 'local')?.summary?.unreadCompletion).toBeUndefined();
  });

});
