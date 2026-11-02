import { describe, expect, it, vi } from 'vitest';
import { SessionRecordReplica, type SessionRecordUpsert } from './SessionRecordReplica';

function record(revision: number, content = 'answer'): SessionRecordUpsert {
  return {
    sessionId: 'session', id: 'item/text', revision,
    turn: { turnId: 'turn', turnIndex: 0, sessionId: 'session', timestamp: 1,
      userMessage: { id: 'user', content: 'question', timestamp: 1 }, startTime: 1, status: 'running' },
    round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, startTime: 2, status: 'running',
      attemptDiagnostics: [{ attemptId: 'attempt', attemptIndex: 1, category: 'retry' }] },
    item: { type: 'text', data: { id: 'text', content, isStreaming: false, timestamp: 3,
      attemptId: 'attempt', attemptIndex: 1, subagentSessionId: 'child' } },
  };
}

describe('SessionRecordReplica', () => {
  it('merges complete blocks by stable identity without duplicating replay', () => {
    const replica = new SessionRecordReplica('session');
    replica.apply(record(1, 'first'));
    const turn = replica.apply(record(2, 'complete'))!.turn!;
    expect(turn.modelRounds[0].textItems.map(item => item.content)).toEqual(['complete']);
    expect(turn.modelRounds[0].textItems[0].subagentSessionId).toBe('child');
    expect(turn.modelRounds[0].attemptDiagnostics?.[0].attemptId).toBe('attempt');
    expect(replica.apply(record(1))).toBeNull();
    expect(replica.apply(record(2))).toBeNull();
  });

  it('ingests without materializing and snapshots the same turn apply would return', () => {
    const replica = new SessionRecordReplica('session');
    const ingested = new SessionRecordReplica('session');
    const materialize = vi.spyOn(ingested as any, 'materialize');

    const applied = [record(1, 'first'), record(2, 'second')].map(value => replica.apply(value))[1];
    expect(ingested.ingest(record(1, 'first'))).toBe('turn');
    expect(ingested.ingest(record(2, 'second'))).toBe('turn');
    expect(ingested.ingest(record(2, 'second'))).toBeNull();
    expect(materialize).not.toHaveBeenCalled();

    expect(ingested.snapshot('turn')).toEqual(applied);
  });

  it('snapshots null for a tombstoned turn and one it never saw', () => {
    const replica = new SessionRecordReplica('session');
    replica.ingest(record(1));
    expect(replica.ingest({ sessionId: 'session', id: 'turn/turn', revision: 2, deleted: true })).toBe('turn');
    expect(replica.snapshot('turn')).toEqual({ turnId: 'turn', turn: null });
    expect(replica.snapshot('unknown')).toEqual({ turnId: 'unknown', turn: null });
  });

  it('loads older blocks without regressing newer turn or round state', () => {
    const replica = new SessionRecordReplica('session');
    const completed = record(5);
    completed.turn.status = 'completed';
    completed.round!.status = 'completed';
    replica.apply(completed);
    const earlier = record(2, 'earlier');
    earlier.id = 'item/earlier';
    earlier.item!.data.id = 'earlier';
    const turn = replica.apply(earlier)!.turn!;
    expect(turn.status).toBe('completed');
    expect(turn.modelRounds[0].status).toBe('completed');
    expect(turn.modelRounds[0].textItems).toHaveLength(2);
  });

  it('rejects another session or mismatched ancestry before changing state', () => {
    const replica = new SessionRecordReplica('session');
    const wrong = record(1);
    wrong.turn.sessionId = 'other';
    expect(() => replica.apply(wrong)).toThrow('another session');
    const wrongRound = record(1);
    wrongRound.round!.turnId = 'another-turn';
    expect(() => replica.apply(wrongRound)).toThrow('ancestry');
    expect(replica.apply(record(1))?.turn?.modelRounds).toHaveLength(1);
  });

  it('retains deletion revisions so backward pages cannot resurrect a turn', () => {
    const replica = new SessionRecordReplica('session');
    replica.apply(record(1));
    expect(replica.apply({ sessionId: 'session', id: 'turn/turn', revision: 10, deleted: true }))
      .toEqual({ turnId: 'turn', turn: null });
    expect(replica.apply(record(5))?.turn).toBeNull();
    const restored = record(11);
    restored.id = 'turn/turn';
    delete restored.round;
    delete restored.item;
    // Recreating a parent does not revive children deleted with it.
    expect(replica.apply(restored)?.turn?.modelRounds).toEqual([]);
    expect(replica.apply(record(12))?.turn?.modelRounds[0].textItems).toHaveLength(1);
  });

  it('accepts a tombstone arriving before the corresponding history page', () => {
    const replica = new SessionRecordReplica('session');
    replica.apply({ sessionId: 'session', id: 'item/text', revision: 10, deleted: true });
    expect(replica.apply(record(2))).toBeNull();
    expect(replica.apply(record(11))?.turn?.modelRounds[0].textItems).toHaveLength(1);
  });
});
