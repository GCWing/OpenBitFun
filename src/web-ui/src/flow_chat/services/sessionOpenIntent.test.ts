import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearHistorySessionOpenTransition,
  clearRecentHistorySessionOpenIntent,
  consumeRecentHistorySessionOpenIntent,
  dispatchHistorySessionOpenIntent,
  getHistorySessionOpenTransitionSnapshot,
  shouldShowHistorySessionOpenIntent,
  subscribeHistorySessionOpenTransition,
} from './sessionOpenIntent';
import type { Session } from '../types/flow-chat';

describe('sessionOpenIntent', () => {
  afterEach(() => {
    clearRecentHistorySessionOpenIntent();
    clearHistorySessionOpenTransition();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('tracks and clears the active history session open transition', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHistorySessionOpenTransition(listener);

    dispatchHistorySessionOpenIntent('history-1', 'History 1');

    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({
      sessionId: 'history-1',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    clearHistorySessionOpenTransition('history-1');

    expect(getHistorySessionOpenTransitionSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('keeps transition active when before-hydrate intent is consumed', () => {
    dispatchHistorySessionOpenIntent('history-1');

    expect(consumeRecentHistorySessionOpenIntent('history-1')).toBe(true);
    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({
      sessionId: 'history-1',
    });
  });

  it('notifies subscribers when a transition expires without owner cleanup', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeHistorySessionOpenTransition(listener);

    dispatchHistorySessionOpenIntent('history-1');

    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({
      sessionId: 'history-1',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3_999);
    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({
      sessionId: 'history-1',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(getHistorySessionOpenTransitionSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('expires stale recent intents and stale transition snapshots', () => {
    const now = vi.fn(() => 100);
    vi.stubGlobal('performance', { now });

    dispatchHistorySessionOpenIntent('history-1');

    now.mockReturnValue(900);
    expect(consumeRecentHistorySessionOpenIntent('history-1')).toBe(false);

    now.mockReturnValue(4_200);
    expect(getHistorySessionOpenTransitionSnapshot()).toBeNull();
  });

  it('does not request a transition shield for running or already-renderable history sessions', () => {
    const metadataOnlySession = {
      sessionId: 'history-1',
      isHistorical: true,
      historyState: 'metadata-only',
      dialogTurns: [],
    } as unknown as Session;
    const renderableSession = {
      ...metadataOnlySession,
      historyState: 'ready',
      dialogTurns: [
        {
          id: 'turn-1',
          userMessage: { id: 'user-1', content: 'visible prompt', timestamp: 1 },
          modelRounds: [],
          status: 'processing',
        },
      ],
    } as unknown as Session;

    expect(shouldShowHistorySessionOpenIntent(metadataOnlySession)).toBe(true);
    expect(shouldShowHistorySessionOpenIntent(metadataOnlySession, { isRunning: true })).toBe(false);
    expect(shouldShowHistorySessionOpenIntent(renderableSession)).toBe(false);
  });

  it('keeps a cross-device open overlay for its longer window, with its title', () => {
    vi.useFakeTimers();
    dispatchHistorySessionOpenIntent('remote-1', 'Remote', 20_000);
    vi.advanceTimersByTime(10_000);
    expect(getHistorySessionOpenTransitionSnapshot()).toMatchObject({ sessionId: 'remote-1', sessionTitle: 'Remote', maxMs: 20_000 });
    vi.advanceTimersByTime(10_000);
    expect(getHistorySessionOpenTransitionSnapshot()).toBeNull();
  });
});
