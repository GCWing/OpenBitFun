import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginHistorySessionDiagnostics,
  recordHistoryPagingEvent,
  recordHistorySessionDiagnosticEvent,
  resetHistorySessionDiagnosticsForTests,
  warnHistoryPagingRefusedWithPendingTurns,
  warnHistorySessionLoadingLayerStalled,
} from './historySessionDiagnostics';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => loggerMock,
}));

describe('historySessionDiagnostics', () => {
  beforeEach(() => {
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    resetHistorySessionDiagnosticsForTests();
  });

  it('logs a stalled loading layer as bounded grouped warnings once', () => {
    const diagnosticId = beginHistorySessionDiagnostics('history-1', 'open_intent', {
      source: 'pointerdown',
    });

    recordHistorySessionDiagnosticEvent('history-1', 'switch_requested', {
      switchRequestId: 1,
      shouldActivateBeforeHydrate: true,
    });
    recordHistorySessionDiagnosticEvent('history-1', 'hydrate_reused_pending', {
      pendingHydrateAgeMs: 125,
    });
    recordHistorySessionDiagnosticEvent('history-1', 'store_stale_commit_skipped', {
      activeSessionIdMatches: false,
    });

    warnHistorySessionLoadingLayerStalled('history-1', {
      durationMs: 800,
      historyState: 'metadata-only',
      isHistorical: true,
      isRemote: false,
      activeSessionIdMatches: true,
      hasRenderableContent: false,
      dialogTurnCount: 0,
    });
    warnHistorySessionLoadingLayerStalled('history-1', {
      durationMs: 1_200,
      historyState: 'metadata-only',
      isHistorical: true,
      isRemote: false,
      activeSessionIdMatches: true,
      hasRenderableContent: false,
      dialogTurnCount: 0,
    });

    expect(loggerMock.warn).toHaveBeenCalledTimes(3);
    expect(loggerMock.warn).toHaveBeenNthCalledWith(
      1,
      'Historical session loading layer stalled',
      expect.objectContaining({
        diagnosticId,
        sessionId: 'history-1',
        durationMs: 800,
        historyState: 'metadata-only',
        hasRenderableContent: false,
      }),
    );
    expect(loggerMock.warn).toHaveBeenNthCalledWith(
      2,
      'Historical session hydrate state at stall',
      expect.objectContaining({
        diagnosticId,
        sessionId: 'history-1',
        lastHydrateEvent: 'hydrate_reused_pending',
        lastStoreEvent: 'store_stale_commit_skipped',
      }),
    );
    expect(loggerMock.warn).toHaveBeenNthCalledWith(
      3,
      'Historical session recent lifecycle events',
      expect.objectContaining({
        diagnosticId,
        sessionId: 'history-1',
        events: expect.arrayContaining([
          expect.objectContaining({ event: 'switch_requested' }),
          expect.objectContaining({ event: 'hydrate_reused_pending' }),
          expect.objectContaining({ event: 'store_stale_commit_skipped' }),
        ]),
      }),
    );
  });
});

describe('history paging diagnostics', () => {
  beforeEach(() => {
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    resetHistorySessionDiagnosticsForTests();
  });

  it('records failure causes without opt-in tracing and deduplicates until recovery', () => {
    const failure = { direction: 'after', reason: 'load-not-found', targetOrdinal: 78 };
    recordHistoryPagingEvent('paging-error', 'outcome_not_ready', failure);
    recordHistoryPagingEvent('paging-error', 'outcome_not_ready', failure);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith('FlowChat history paging did not become ready', expect.objectContaining(failure));
    recordHistoryPagingEvent('paging-error', 'outcome_applied');
    recordHistoryPagingEvent('paging-error', 'outcome_not_ready', failure);
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  it('warns once with the paging trail when older Turns are refused', () => {
    recordHistoryPagingEvent('paging-1', 'requested', {
      direction: 'before',
      resolvedTotalTurnCount: 0,
      loadedTurnCount: 3,
    });
    recordHistoryPagingEvent('paging-1', 'outcome_exhausted', {
      direction: 'before',
      reason: 'beyond-known-total',
      targetOrdinal: 2,
      totalTurnCount: 0,
    });

    warnHistoryPagingRefusedWithPendingTurns('paging-1', {
      direction: 'before',
      reason: 'exhausted-on-unknown-total',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 0,
      targetOrdinal: 2,
    });

    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
    const [refusal, trail] = loggerMock.warn.mock.calls;
    expect(refusal[0]).toContain('declined to page older Turns');
    expect(refusal[1]).toMatchObject({
      sessionId: 'paging-1',
      reason: 'exhausted-on-unknown-total',
      isPartial: true,
      totalTurnCount: 0,
    });
    // The decisive prior step travels with the warning.
    expect(refusal[1].lastOutcome).toBe('history_paging_outcome_exhausted');
    expect(refusal[1].lastOutcomeData).toMatchObject({ reason: 'beyond-known-total' });
    expect(trail[1].events.map((event: { event: string }) => event.event)).toEqual([
      'history_paging_requested',
      'history_paging_outcome_exhausted',
      'history_paging_refused_with_pending_turns',
    ]);
  });

  it('stays quiet on repeat refusals so scrolling cannot flood the log', () => {
    const snapshot = {
      direction: 'before',
      reason: 'latched-exhausted-while-partial',
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 22,
    };
    warnHistoryPagingRefusedWithPendingTurns('paging-2', snapshot);
    warnHistoryPagingRefusedWithPendingTurns('paging-2', snapshot);
    warnHistoryPagingRefusedWithPendingTurns('paging-2', snapshot);

    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the latch per session', () => {
    const snapshot = { direction: 'before', reason: 'latched-exhausted-while-partial' };
    warnHistoryPagingRefusedWithPendingTurns('paging-3', snapshot);
    warnHistoryPagingRefusedWithPendingTurns('paging-4', snapshot);

    expect(loggerMock.warn).toHaveBeenCalledTimes(4);
  });
});
