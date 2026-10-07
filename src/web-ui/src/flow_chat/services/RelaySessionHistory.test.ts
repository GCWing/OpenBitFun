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
  afterEach(() => { vi.useRealTimers(); });

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
