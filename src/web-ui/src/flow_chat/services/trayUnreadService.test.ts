import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';

const source = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  notify: undefined as (() => void) | undefined,
  desktop: true,
  send: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn(),
  onMarkAllRead: undefined as (() => void) | undefined,
}));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => source.desktop }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {
  setTrayUnreadCount: source.send,
  onTrayMarkAllRead: (callback: () => void) => {
    source.onMarkAllRead = callback;
    return () => { source.onMarkAllRead = undefined; };
  },
} }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: source.sessions }),
  subscribe: (notify: () => void) => { source.notify = notify; return () => { source.notify = undefined; }; },
  clearAllSessionUnreadCompletions: source.markAllRead,
} }));
import { countUnreadSessions, installTrayUnreadService } from './trayUnreadService';

const session = (extra: Partial<Session> = {}) => ({ sessionId: 'one', ...extra }) as Session;
afterEach(() => {
  source.sessions.clear();
  source.notify = undefined;
  source.desktop = true;
  source.send.mockClear();
  source.markAllRead.mockClear();
  source.onMarkAllRead = undefined;
  vi.useRealTimers();
});

describe('tray unread projection', () => {
  it('counts terminal receipts once per visible session and tolerates legacy missing receipts', () => {
    expect(countUnreadSessions([
      session(), session({ hasUnreadCompletion: 'completed' }),
      session({ hasUnreadCompletion: 'error' }), session({ hasUnreadCompletion: 'interrupted' }),
      session({ hasUnreadCompletion: 'completed', isTransient: true }),
      session({ hasUnreadCompletion: 'completed', sessionKind: 'subagent' }),
      session({ hasUnreadCompletion: 'completed', parentSessionId: 'parent', sessionKind: 'btw' }),
    ])).toBe(4);
  });

  it('hydrates, clears after reading, and replaces counts when switching to peer sessions', async () => {
    vi.useFakeTimers();
    source.sessions.set('one', session({ hasUnreadCompletion: 'completed' }));
    const dispose = installTrayUnreadService();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenLastCalledWith(1);
    source.notify?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenCalledTimes(1);
    source.sessions.set('one', session());
    source.notify?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenLastCalledWith(0);
    source.sessions = new Map([['remote', session({ hasUnreadCompletion: 'completed', remoteConnectionId: 'ssh' })]]);
    source.notify?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenLastCalledWith(1);
    dispose();
    expect(source.notify).toBeUndefined();
  });

  it('coalesces a foreground completion acknowledged before paint', async () => {
    vi.useFakeTimers();
    const dispose = installTrayUnreadService();
    source.sessions.set('one', session({ hasUnreadCompletion: 'completed' }));
    source.notify?.();
    source.sessions.set('one', session());
    source.notify?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenCalledExactlyOnceWith(0);
    dispose();
  });

  it('serializes updates so a slow native call cannot restore a stale count', async () => {
    vi.useFakeTimers();
    let resolve: () => void = () => {};
    source.send.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    source.sessions.set('one', session({ hasUnreadCompletion: 'completed' }));
    const dispose = installTrayUnreadService();
    await vi.advanceTimersByTimeAsync(100);
    source.sessions.clear();
    source.notify?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(source.send).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.send.mock.calls.map(args => args[0])).toEqual([1, 0]);
    dispose();
  });

  it('retries a failed native update without requiring another session event', async () => {
    vi.useFakeTimers();
    source.send.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const dispose = installTrayUnreadService();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(source.send).toHaveBeenCalledTimes(2);
    expect(source.send).toHaveBeenLastCalledWith(0);
    dispose();
  });

  it('clears every unread receipt when the tray menu asks, and detaches on dispose', async () => {
    vi.useFakeTimers();
    const dispose = installTrayUnreadService();
    await vi.advanceTimersByTimeAsync(100);
    source.onMarkAllRead?.();
    expect(source.markAllRead).toHaveBeenCalledTimes(1);
    dispose();
    expect(source.onMarkAllRead).toBeUndefined();
  });

  it('does not install native IO on web surfaces', () => {
    source.desktop = false;
    installTrayUnreadService()();
    expect(source.notify).toBeUndefined();
    expect(source.send).not.toHaveBeenCalled();
  });
});
