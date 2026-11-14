import { describe, expect, it } from 'vitest';
import type { DialogTurn, Session } from '../../types/flow-chat';
import { canonicalSessionTurns, resolveTurnOrdinal } from '../../utils/flowChatTurnIdentity';
import { createFlowChatTurnSummaryProjector } from './flowChatTurnSummaries';

function turn(id: string, storageTurnIndex?: number): DialogTurn {
  return {
    id, sessionId: 'session', storageTurnIndex, status: 'completed', startTime: 1,
    userMessage: { id: `user-${id}`, content: id, timestamp: 1 }, modelRounds: [],
  };
}

function session(dialogTurns = [turn('a'), turn('b')], overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session', dialogTurns, config: {}, status: 'idle', createdAt: 1,
    lastActiveAt: 1, error: null, sessionKind: 'flow_chat', ...overrides,
  };
}

// The previous container path remains an independent semantic oracle for small
// fixtures: single-Turn lookup, including its catalog-only and legacy fallbacks.
function reference(s: Session, rendered = s.dialogTurns, startOrdinal?: number) {
  const turnSummaries = canonicalSessionTurns(s).map((t, index) => ({
    turnId: t.id, turnIndex: (resolveTurnOrdinal(s, t) ?? index) + 1,
    storageTurnIndex: t.storageTurnIndex ?? t.backendTurnIndex,
  }));
  const renderedTurnSummaries = rendered.filter(t => t.userMessage?.metadata?.usageReportProvisional !== true)
    .map((t, index) => ({ turnId: t.id, turnIndex: index + 1, storageTurnIndex: t.storageTurnIndex ?? t.backendTurnIndex }));
  return {
    turnSummaries, renderedTurnSummaries,
    absoluteRenderedTurnSummaries: renderedTurnSummaries.map((t, index) => ({
      ...t, turnIndex: startOrdinal !== undefined ? startOrdinal + index + 1
        : (resolveTurnOrdinal(s, t.turnId) ?? t.turnIndex - 1) + 1,
    })),
  };
}

describe('FlowChat Turn summary projection', () => {
  it('reuses all summary arrays across streamed text, completion and unrelated Session updates', () => {
    const project = createFlowChatTurnSummaryProjector();
    let s = session(Array.from({ length: 1200 }, (_, i) => turn(`turn-${i}`, i)));
    const first = project(s, s.dialogTurns);
    for (let i = 0; i < 40; i++) {
      s = { ...s, lastActiveAt: i, dialogTurns: s.dialogTurns.map((t, index) => index < 1199 ? t : {
        ...t, status: i === 39 ? 'completed' : 'processing',
        modelRounds: [{ id: 'round', index: 0, status: 'streaming', startTime: 1, isStreaming: true, isComplete: false, items: [
          { id: 'text', type: 'text', content: 'streamed text '.repeat(i + 1), isStreaming: true, timestamp: 1 },
        ] }],
      }) };
      expect(project(s, s.dialogTurns)).toBe(first);
    }
    expect(first.turnSummaries).toHaveLength(1200);
    expect(first.absoluteRenderedTurnSummaries.at(-1)?.turnIndex).toBe(1200);
  });

  it('invalidates partial-tail offsets on count changes, append, rollback and history completion', () => {
    const project = createFlowChatTurnSummaryProjector();
    let s = session(undefined, { isPartial: true, totalTurnCount: 100 });
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
    expect(project(s, s.dialogTurns).turnSummaries.map(t => t.turnIndex)).toEqual([99, 100]);
    for (const patch of [
      { totalTurnCount: 101 },
      { dialogTurns: [...s.dialogTurns, turn('c')], totalTurnCount: 102 },
      { dialogTurns: [turn('replacement'), turn('b')], totalTurnCount: 100 },
      { isPartial: false },
    ]) {
      s = { ...s, ...patch };
      expect(project(s, s.dialogTurns)).toEqual(reference(s));
    }
  });

  it('preserves catalog ordinals, deprecated storage indexes and catalog-only history', () => {
    const project = createFlowChatTurnSummaryProjector();
    const legacy = turn('b'); legacy.backendTurnIndex = 99;
    const s = session([turn('a', 40), legacy, turn('c')], {
      isPartial: true, totalTurnCount: 12,
      turnCatalog: {
        schemaVersion: 1, sessionId: 'session', revision: 'catalog', complete: false, totalTurnCount: 12,
        entries: ['a', 'b', 'c', 'history-only'].map((turnId, i) => ({
          turnId, ordinal: i + 8, storageTurnIndex: [40, 99, 200, 300][i], previewTruncated: false,
        })),
      },
    });
    const rendered = [turn('history-only')];
    expect(project(s, rendered)).toEqual(reference(s, rendered));
    expect(project(s, rendered).absoluteRenderedTurnSummaries[0].turnIndex).toBe(12);
    const first = project(s, rendered, 4);
    const moved = project(s, rendered, 7);
    expect(moved.turnSummaries).toBe(first.turnSummaries);
    expect(moved.renderedTurnSummaries).toBe(first.renderedTurnSummaries);
    expect(moved.absoluteRenderedTurnSummaries[0].turnIndex).toBe(8);
    expect(project(s, [], 7).absoluteRenderedTurnSummaries).toEqual([]);
  });

  it('keeps provisional usage reports out until committed, with the existing render filter', () => {
    const project = createFlowChatTurnSummaryProjector();
    const provisional: DialogTurn = {
      ...turn('usage'), kind: 'local_command', userMessage: {
        id: 'usage-user', content: 'report', timestamp: 1,
        metadata: { localCommandKind: 'usage_report', usageReportProvisional: true },
      },
    };
    const s = session([turn('a'), provisional, turn('b')], { isPartial: true, totalTurnCount: 100 });
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
    provisional.userMessage!.metadata = { localCommandKind: 'usage_report', usageReportProvisional: false };
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
    provisional.userMessage!.metadata = { usageReportProvisional: true };
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
  });

  it('refreshes equal-length identity corrections and catalog changes without retaining body updates', () => {
    const project = createFlowChatTurnSummaryProjector();
    const s = session([turn('a', 40)], {
      turnCatalog: {
        schemaVersion: 1, sessionId: 'session', revision: 'catalog', complete: true, totalTurnCount: 1,
        entries: [{ ordinal: 0, storageTurnIndex: 40, previewTruncated: false }],
      },
    });
    const first = project(s, s.dialogTurns);
    s.turnCatalog!.entries[0].ordinal = 9;
    expect(project(s, s.dialogTurns).turnSummaries[0].turnIndex).toBe(10);
    s.dialogTurns[0].storageTurnIndex = 41;
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
    s.dialogTurns[0].id = 'host-corrected-id';
    expect(project(s, s.dialogTurns).turnSummaries[0].turnId).toBe('host-corrected-id');
    expect(project(s, s.dialogTurns)).not.toBe(first);
  });

  it('ignores catalog preview-only changes and isolates cleared or switched Sessions', () => {
    const project = createFlowChatTurnSummaryProjector();
    const s = session(undefined, { turnCatalog: {
      schemaVersion: 1, sessionId: 'session', revision: 'one', complete: true, totalTurnCount: 2,
      entries: [{ turnId: 'a', ordinal: 0, storageTurnIndex: 0, preview: 'old', previewTruncated: false }],
    } });
    const first = project(s, s.dialogTurns);
    const preview = { ...s, turnCatalog: { ...s.turnCatalog!, revision: 'two', entries: s.turnCatalog!.entries.map(e => ({ ...e, preview: 'new' })) } };
    expect(project(preview, preview.dialogTurns)).toBe(first);
    const other = { ...s, sessionId: 'other', isPartial: true, totalTurnCount: 50 };
    expect(project(other, other.dialogTurns)).toEqual(reference(other));
    const empty = project(null, []);
    expect(empty).toEqual({ turnSummaries: [], renderedTurnSummaries: [], absoluteRenderedTurnSummaries: [] });
    expect(project(undefined, [])).toBe(empty);
    expect(project(s, s.dialogTurns)).toEqual(reference(s));
  });

  it('keeps the single-Turn semantics for duplicate legacy IDs and missing catalog IDs', () => {
    const s = session([turn('duplicate', 10), turn('duplicate', 20), turn(''), turn('fallback')], {
      turnCatalog: {
        schemaVersion: 1, sessionId: 'session', revision: 'legacy', complete: true, totalTurnCount: 4,
        entries: [
          { ordinal: 0, storageTurnIndex: 10, previewTruncated: false },
          { ordinal: 1, storageTurnIndex: 20, previewTruncated: false },
          { turnId: '', ordinal: 2, storageTurnIndex: 30, previewTruncated: false },
          { turnId: '', ordinal: 3, storageTurnIndex: 40, previewTruncated: false },
        ],
      },
    });
    expect(createFlowChatTurnSummaryProjector()(s, s.dialogTurns)).toEqual(reference(s));
  });
});
