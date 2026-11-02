// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: any) => void;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, Set<(payload: any) => void>>(),
  ready: new Set<(payload: any) => void>(),
  syncError: new Set<(payload: any) => void>(),
  subscribeSession: vi.fn(),
  unsubscribeSession: vi.fn(),
  surfaceId: 'peer-cli',
  current: true,
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    invoke: mocks.invoke,
    listen: (event: string, callback: Listener) => {
      const set = mocks.listeners.get(event) ?? new Set<Listener>();
      set.add(callback);
      mocks.listeners.set(event, set);
      return () => set.delete(callback);
    },
  },
}));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', () => ({
  remoteConnectAPI: {
    subscribeSession: mocks.subscribeSession,
    unsubscribeSession: mocks.unsubscribeSession,
    onSessionReady: (callback: Listener) => {
      mocks.ready.add(callback);
      return () => mocks.ready.delete(callback);
    },
    onSessionSyncError: (callback: Listener) => {
      mocks.syncError.add(callback);
      return () => mocks.syncError.delete(callback);
    },
  },
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => ({ surfaceId: mocks.surfaceId, isCurrent: () => mocks.current }),
}));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PeerTerminalReplay, type PeerTerminalRawEvent } from './PeerTerminalReplay';

const emit = (event: string, payload: unknown) =>
  [...(mocks.listeners.get(event) ?? [])].forEach(listener => listener(payload));
const ready = () =>
  [...mocks.ready].forEach(listener => listener({ sessionId: 'terminal-t1', hasMore: false, oldestSeq: 0, cursor: 0 }));
const page = (data: string, nextOffset: number, cursor = nextOffset, truncated = false) => ({
  data, nextOffset, cursor, truncated,
});
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('PeerTerminalReplay', () => {
  let events: PeerTerminalRawEvent[];
  let replay: PeerTerminalReplay;

  beforeEach(() => {
    events = [];
    mocks.invoke.mockReset();
    mocks.listeners.clear();
    mocks.ready.clear();
    mocks.syncError.clear();
    mocks.subscribeSession.mockReset().mockResolvedValue('subscription-1');
    mocks.unsubscribeSession.mockReset().mockResolvedValue(undefined);
    mocks.current = true;
    replay = new PeerTerminalReplay('t1', event => events.push(event));
    replay.follow(10);
  });

  afterEach(() => {
    replay.close();
    vi.useRealTimers();
  });

  it('opens the terminal stream on the rendered peer', () => {
    replay.start();
    expect(mocks.subscribeSession).toHaveBeenCalledWith('peer-cli', 'terminal-t1');
  });

  it('continues after the history offset and follows cursor hints', async () => {
    mocks.invoke.mockResolvedValueOnce(page('prompt$ ', 18)).mockResolvedValueOnce(page('ls\r\n', 22));
    replay.start();
    emit('terminal-output', { terminal_id: 't1', cursor: 18 });
    await flush();
    expect(mocks.invoke, 'hints replayed before the first page was applied are ignored').not.toHaveBeenCalled();

    ready();
    await flush();
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_get_history', { sessionId: 't1', afterOffset: 10 });
    emit('terminal-output', { terminal_id: 't1', cursor: 22 });
    await flush();
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_get_history', { sessionId: 't1', afterOffset: 18 });
    expect(events.map(event => event.payload.data)).toEqual(['prompt$ ', 'ls\r\n']);
  });

  it('ignores hints for another terminal', async () => {
    mocks.invoke.mockResolvedValue(page('', 10));
    replay.start();
    ready();
    await flush();
    mocks.invoke.mockClear();
    emit('terminal-output', { terminal_id: 'other', cursor: 99 });
    await flush();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('drains every bounded page before stopping', async () => {
    mocks.invoke.mockResolvedValueOnce(page('a', 11, 13)).mockResolvedValueOnce(page('b', 12, 13)).mockResolvedValueOnce(page('c', 13, 13));
    replay.start();
    ready();
    await flush();
    expect(events.map(event => event.payload.data)).toEqual(['a', 'b', 'c']);
  });

  it('resets the screen when output left the bounded replay log', async () => {
    mocks.invoke.mockResolvedValueOnce(page('tail', 500, 500, true));
    replay.start();
    ready();
    await flush();
    expect(events[0].payload.data).toBe('\x1bctail');
  });

  it('delivers an exit only after the output already in the log', async () => {
    mocks.invoke.mockResolvedValueOnce(page('bye\r\n', 15));
    replay.start();
    emit('terminal-exit', { terminal_id: 't1', exit_code: 3 });
    expect(events).toEqual([]);
    ready();
    await flush();
    expect(events.map(event => event.type)).toEqual(['Data', 'Exit']);
    expect(events[1].payload.exit_code).toBe(3);
  });

  it('maps a closed session to the destroyed event', async () => {
    mocks.invoke.mockResolvedValue(page('', 10));
    replay.start();
    ready();
    await flush();
    emit('terminal-closed', { terminal_id: 't1' });
    await flush();
    expect(events.at(-1)?.type).toBe('SessionDestroyed');
  });

  it('reports a vanished session from the session list, not the error text', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('any host wording')).mockResolvedValueOnce([{ id: 'other' }]);
    replay.start();
    ready();
    await flush();
    await flush();
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_list');
    expect(events).toEqual([{ type: 'SessionDestroyed', payload: { session_id: 't1' } }]);
  });

  it('keeps a listed session after a failed read', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockRejectedValueOnce(new Error('relay timeout')).mockResolvedValueOnce([{ id: 't1' }]);
    replay.start();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
  });

  it('retries a failed read from the same offset without losing output', async () => {
    vi.useFakeTimers();
    mocks.invoke
      .mockRejectedValueOnce(new Error('relay timeout'))
      .mockResolvedValueOnce([{ id: 't1' }])
      .mockResolvedValueOnce(page('late', 14));
    replay.start();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_get_history', { sessionId: 't1', afterOffset: 10 });
    expect(events[0].payload.data).toBe('late');
  });

  it('surfaces a stream a host cannot open instead of staying silent', async () => {
    mocks.subscribeSession.mockRejectedValueOnce(new Error('older OpenBitFun version'));
    replay.start();
    await flush();
    expect(events).toEqual([{ type: 'Error', payload: { session_id: 't1', message: 'older OpenBitFun version' } }]);
  });

  it('stays attached through a sync error after catching up', async () => {
    mocks.invoke.mockResolvedValue(page('', 10));
    replay.start();
    ready();
    await flush();
    [...mocks.syncError].forEach(listener => listener({ sessionId: 'terminal-t1', targetDeviceId: 'peer-cli', message: 'relay dropped' }));
    expect(events).toEqual([]);
  });

  it('drops late pages after the surface changed and releases the stream on close', async () => {
    mocks.invoke.mockResolvedValueOnce(page('stale', 15));
    replay.start();
    await flush();
    ready();
    mocks.current = false;
    await flush();
    expect(events).toEqual([]);

    replay.close();
    expect(mocks.unsubscribeSession).toHaveBeenCalledWith('subscription-1');
    expect(mocks.listeners.get('terminal-output')?.size).toBe(0);
  });

  describe('without a mounted view', () => {
    let tracked: PeerTerminalReplay;

    beforeEach(() => {
      tracked = new PeerTerminalReplay('t1', event => events.push(event));
    });

    afterEach(() => tracked.close());

    it('reports the lifecycle without reading output', async () => {
      tracked.start();
      ready();
      emit('terminal-output', { terminal_id: 't1', cursor: 50 });
      await flush();
      expect(mocks.invoke).not.toHaveBeenCalled();

      emit('terminal-exit', { terminal_id: 't1', exit_code: 0 });
      expect(events).toEqual([{ type: 'Exit', payload: { session_id: 't1', exit_code: 0 } }]);
    });

    it('starts reading when a view follows and stops when it leaves', async () => {
      mocks.invoke.mockResolvedValue(page('x', 21));
      tracked.start();
      ready();
      tracked.follow(20);
      await flush();
      expect(mocks.invoke).toHaveBeenLastCalledWith('terminal_get_history', { sessionId: 't1', afterOffset: 20 });

      mocks.invoke.mockClear();
      tracked.unfollow();
      emit('terminal-output', { terminal_id: 't1', cursor: 30 });
      await flush();
      expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it('drops a page read for a view that left', async () => {
      let finish!: (value: unknown) => void;
      mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      tracked.start();
      tracked.follow(20);
      ready();
      await flush();
      tracked.unfollow();
      finish(page('stale', 25));
      await flush();
      expect(events).toEqual([]);
    });

    it('shows a stream failure to the view that arrives later', async () => {
      mocks.subscribeSession.mockRejectedValueOnce(new Error('older OpenBitFun version'));
      tracked.start();
      await flush();
      expect(events).toEqual([]);
      tracked.follow(0);
      expect(events).toEqual([{ type: 'Error', payload: { session_id: 't1', message: 'older OpenBitFun version' } }]);
    });
  });
});
