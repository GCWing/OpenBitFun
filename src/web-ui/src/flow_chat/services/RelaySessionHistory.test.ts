import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  current: true,
  interaction: null as ((event: any) => void) | null,
  record: null as ((event: unknown) => void) | null,
  ready: null as ((event: any) => void) | null,
  error: null as ((event: any) => void) | null,
  subscribe: vi.fn(), unsubscribe: vi.fn(async () => {}), older: vi.fn(async () => {}),
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => ({ surfaceId: 'host', isCurrent: () => fixture.current,
    assertCurrent: () => { if (!fixture.current) throw new Error('Surface changed'); } }),
}));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({ remoteConnectAPI: {
  onSessionInteractionChanged: (listener: (event:any)=>void) => {fixture.interaction=listener;return()=>{fixture.interaction=null;};},
  onSessionRecord: (listener: (event: unknown) => void) => { fixture.record = listener; return () => { fixture.record = null; }; },
  onSessionReady: (listener: (event: any) => void) => { fixture.ready = listener; return () => { fixture.ready = null; }; },
  onSessionSyncError: (listener: (event: any) => void) => { fixture.error = listener; return () => { fixture.error = null; }; },
  subscribeSession: fixture.subscribe, unsubscribeSession: fixture.unsubscribe, loadOlderSession: fixture.older,
} }));

import { RelaySessionHistory } from './RelaySessionHistory';

describe('RelaySessionHistory', () => {
  beforeEach(() => { vi.clearAllMocks(); fixture.current = true; });
  afterEach(() => {
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers before cache replay, then uses the same subscription for older pages', async () => {
    const apply = vi.fn();
    fixture.subscribe.mockImplementation(async () => {
      fixture.record?.({ sessionId: 'session', id: 'turn/turn' });
      fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 50, cursor: 150 });
      return 'subscription';
    });
    const history = new RelaySessionHistory('session', apply, vi.fn(), vi.fn());
    await history.open();
    fixture.older.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 150 });
    });
    await Promise.all([history.loadOlder(), history.loadOlder()]);
    expect(apply).toHaveBeenCalledOnce();
    expect(fixture.subscribe).toHaveBeenCalledOnce();
    expect(fixture.older).toHaveBeenCalledWith('subscription');
    expect(fixture.older).toHaveBeenCalledOnce();
    history.close();
    expect(fixture.unsubscribe).toHaveBeenCalledWith('subscription');
    expect(fixture.record).toBeNull();
  });

  it('surfaces replay failures instead of leaving the first page loading forever', async () => {
    fixture.subscribe.mockImplementation(async () => {
      fixture.error?.({ sessionId: 'session', targetDeviceId: 'host', message: 'Unreadable session' });
      return 'subscription';
    });
    const error = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), error);
    await expect(history.open()).rejects.toThrow('Unreadable session');
    expect(error).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledWith('subscription');
  });

  it('fails an overdue first page as retryable without claiming an empty complete history', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockResolvedValueOnce('subscription');
    const apply = vi.fn();
    const flushed = vi.fn();
    const ready = vi.fn();
    const error = vi.fn();
    const resumed = vi.fn(async () => {});
    const history = new RelaySessionHistory('session', apply, ready, error, resumed, flushed);

    const opening = history.open();
    const outcome = expect(opening).rejects.toMatchObject({
      name: 'RelayHistoryFirstPageOverdueError', retryable: true, sessionId: 'session',
    });
    await vi.advanceTimersByTimeAsync(0);
    // Records that did arrive are known history and must stay rendered.
    fixture.record?.({ sessionId: 'session', id: 'item/known' });
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;

    expect(apply).toHaveBeenCalledOnce();
    expect(flushed).toHaveBeenCalled();
    // A blocking question is answerable from the mailbox without the page.
    expect(resumed).toHaveBeenCalledOnce();
    // Never a synthetic ready: no fake `hasMore: false` or zero cursor.
    expect(ready).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledWith('subscription');

    // A late page belongs to a closed read; retrying opens a fresh one.
    expect(fixture.ready).toBeNull();
  });

  it('keeps a first page that arrives before the deadline and clears the deadline', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockResolvedValueOnce('subscription');
    const ready = vi.fn();
    const error = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), ready, error, async () => {});

    const opening = history.open();
    await vi.advanceTimersByTimeAsync(14_000);
    fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 5, cursor: 9 });
    await opening;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(ready).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session', hasMore: true, oldestSeq: 5, cursor: 9,
    });
    expect(error).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    history.close();
  });

  it('does not report an overdue page for a read that was closed or switched away', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockResolvedValue('subscription');
    const closedError = vi.fn();
    const closedResume = vi.fn(async () => {});
    const closed = new RelaySessionHistory('session', vi.fn(), vi.fn(), closedError, closedResume);
    const closing = expect(closed.open()).rejects.toThrow('Session subscription closed');
    await vi.advanceTimersByTimeAsync(0);
    closed.close();
    await closing;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closedError).not.toHaveBeenCalled();
    expect(closedResume).not.toHaveBeenCalled();

    const switchedError = vi.fn();
    const switchedResume = vi.fn(async () => {});
    const switched = new RelaySessionHistory('session', vi.fn(), vi.fn(), switchedError, switchedResume);
    const switching = expect(switched.open()).rejects.toThrow('first page overdue');
    await vi.advanceTimersByTimeAsync(0);
    fixture.current = false;
    await vi.advanceTimersByTimeAsync(15_000);
    await switching;
    expect(switchedError).not.toHaveBeenCalled();
    expect(switchedResume).not.toHaveBeenCalled();
  });

  it('drops stale replay and unsubscribes when the surface changes during grant', async () => {
    const apply = vi.fn();
    fixture.subscribe.mockImplementation(async () => {
      fixture.current = false;
      fixture.record?.({ sessionId: 'session' });
      return 'subscription';
    });
    const history = new RelaySessionHistory('session', apply, vi.fn(), vi.fn());
    await expect(history.open()).rejects.toThrow('Surface changed');
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).toHaveBeenCalledWith('subscription');
  });
  it('flushes a replayed page once, before its ready event', async () => {
    const order: string[] = [];
    fixture.subscribe.mockImplementation(async () => {
      for (let index = 0; index < 50; index += 1) fixture.record?.({ sessionId: 'session', id: `item/${index}` });
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 50 });
      return 'subscription';
    });
    const history = new RelaySessionHistory('session', () => order.push('record'), () => order.push('ready'), vi.fn(),
      undefined, () => order.push('flush'));
    await history.open();
    expect(order.filter(entry => entry === 'flush')).toHaveLength(1);
    expect(order.slice(-2)).toEqual(['flush', 'ready']);
    history.close();
  });

  it('keeps a page in one batch across frames but cannot be stalled by it', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 50, cursor: 150 });
      return 'subscription';
    });
    fixture.older.mockImplementation(() => new Promise<void>(() => {}));
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    void history.loadOlder().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index += 1) {
      fixture.record?.({ sessionId: 'session', id: `item/${index}` });
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(flush).not.toHaveBeenCalled();
    fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 150 });
    expect(flush).toHaveBeenCalledOnce();

    void history.loadOlder().catch(() => {});
    fixture.record?.({ sessionId: 'session', id: 'item/stalled' });
    await vi.advanceTimersByTimeAsync(250);
    expect(flush).toHaveBeenCalledTimes(2);
    history.close();
  });

  it('flushes live records that have no ready event once per frame', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 0 });
      return 'subscription';
    });
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    fixture.record?.({ sessionId: 'session', id: 'item/1' });
    fixture.record?.({ sessionId: 'session', id: 'item/2' });
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(flush).toHaveBeenCalledOnce();

    fixture.record?.({ sessionId: 'session', id: 'item/3' });
    await vi.advanceTimersByTimeAsync(16);
    expect(flush).toHaveBeenCalledTimes(2);
    history.close();
  });

  it('flushes at once when a record cannot wait for the next frame', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 0 });
      return 'subscription';
    });
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', record => (record as any).id === 'item/final',
      vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    fixture.record?.({ sessionId: 'session', id: 'item/1' });
    expect(flush).not.toHaveBeenCalled();
    fixture.record?.({ sessionId: 'session', id: 'item/final' });
    expect(flush).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(16);
    expect(flush).toHaveBeenCalledOnce();
    history.close();
  });

  it('flushes on a visibility change instead of waiting for a throttled timer', async () => {
    vi.useFakeTimers();
    const listeners: Array<() => void> = [];
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    });
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 0 });
      return 'subscription';
    });
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    listeners.forEach(listener => listener());
    expect(flush).not.toHaveBeenCalled();
    fixture.record?.({ sessionId: 'session', id: 'item/1' });
    listeners.forEach(listener => listener());
    expect(flush).toHaveBeenCalledOnce();
    history.close();
  });

  it('reports a flush failure and does not announce the page as ready', async () => {
    fixture.subscribe.mockImplementation(async () => {
      fixture.record?.({ sessionId: 'session', id: 'item/1' });
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 1 });
      return 'subscription';
    });
    const ready = vi.fn();
    const error = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), ready, error, undefined, () => {
      throw new Error('Unrenderable record');
    });
    await expect(history.open()).rejects.toThrow('Unrenderable record');
    expect(error).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });

  it('renders received records before a sync error and on close', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 0 });
      return 'subscription';
    });
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    fixture.record?.({ sessionId: 'session', id: 'item/1' });
    fixture.error?.({ sessionId: 'session', targetDeviceId: 'host', message: 'Page failed' });
    expect(flush).toHaveBeenCalledOnce();

    fixture.record?.({ sessionId: 'session', id: 'item/2' });
    history.close();
    expect(flush).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(16);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('leaves records pending when the surface changed before the flush', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: false, oldestSeq: 1, cursor: 0 });
      return 'subscription';
    });
    const flush = vi.fn();
    const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), undefined, flush);
    await history.open();
    flush.mockClear();

    fixture.record?.({ sessionId: 'session', id: 'item/1' });
    fixture.current = false;
    await vi.advanceTimersByTimeAsync(16);
    history.close();

    expect(flush).not.toHaveBeenCalled();
  });

  it('rejects an older page when its reducer fails even if the host RPC succeeds', async () => {
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 50, cursor: 150 });
      return 'subscription';
    });
    const apply = vi.fn(() => { throw new Error('Invalid historical record'); });
    const history = new RelaySessionHistory('session', apply, vi.fn(), vi.fn());
    await history.open();
    fixture.older.mockImplementation(async () => {
      fixture.record?.({ sessionId: 'session', id: 'invalid' });
    });
    await expect(history.loadOlder()).rejects.toThrow('Invalid historical record');
    history.close();
  });

  it('warms only one adjacent page while visible and retains live delivery when hidden', async () => {
    vi.useFakeTimers();
    fixture.subscribe.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 50, cursor: 150 });
      return 'subscription';
    });
    fixture.older.mockImplementation(async () => {
      fixture.ready?.({ sessionId: 'session', hasMore: true, oldestSeq: 20, cursor: 150 });
    });
    const apply = vi.fn();
    const history = new RelaySessionHistory('session', apply, vi.fn(), vi.fn());
    await history.open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.older).not.toHaveBeenCalled();
    history.setVisible(true);
    expect(fixture.older).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.older).toHaveBeenCalledOnce();
    history.setVisible(false);
    fixture.record?.({ sessionId: 'session', id: 'live' });
    expect(apply).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.older).toHaveBeenCalledOnce();
    history.close();
  });

});

it('refreshes the small mailbox on initial ready and reconnect, but never on older-page ready', async () => {
  fixture.current = true;
  const resumed = vi.fn(async () => {});
  fixture.subscribe.mockImplementation(async () => { fixture.ready?.({sessionId:'session',hasMore:true,oldestSeq:5,cursor:10}); return 'subscription'; });
  fixture.older.mockImplementation(async () => { fixture.ready?.({sessionId:'session',hasMore:false,oldestSeq:1,cursor:10}); });
  const history = new RelaySessionHistory('session', vi.fn(), vi.fn(), vi.fn(), resumed);
  await history.open(); expect(resumed).toHaveBeenCalledTimes(1);
  await history.loadOlder(); expect(resumed).toHaveBeenCalledTimes(1);
  fixture.ready?.({sessionId:'session',hasMore:false,oldestSeq:1,cursor:12});
  expect(resumed).toHaveBeenCalledTimes(2);
  fixture.interaction?.({sessionId:"session",userQuestionsRevision:2});
  expect(resumed).toHaveBeenCalledTimes(3);
  history.close();
});
