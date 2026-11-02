// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { getState: () => ({ openedWorkspaces: new Map(), recentWorkspaces: [] }) } }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

const hostMock = vi.hoisted(() => ({
  capabilities: null as Record<string, unknown> | null,
  listeners: new Set<() => void>(),
}));
const replayMock = vi.hoisted(() => ({
  created: [] as Array<{
    sessionId: string;
    deliver: (event: unknown) => void;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    follow: ReturnType<typeof vi.fn>;
    unfollow: ReturnType<typeof vi.fn>;
    isFollowing: () => boolean;
  }>,
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: {
    get: () => ({ getState: () => ({ capabilities: hostMock.capabilities }) }),
    subscribe: (listener: () => void) => {
      hostMock.listeners.add(listener);
      return () => hostMock.listeners.delete(listener);
    },
  },
}));
vi.mock('./PeerTerminalReplay', () => ({
  PeerTerminalReplay: class {
    following = false;
    start = vi.fn();
    close = vi.fn();
    follow = vi.fn(() => { this.following = true; });
    unfollow = vi.fn(() => { this.following = false; });
    isFollowing = () => this.following;
    constructor(public sessionId: string, public deliver: (event: unknown) => void) {
      replayMock.created.push(this);
    }
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { TerminalService } from './TerminalService';
import {
  activateSurface,
  resetDeviceSurfaceForTest,
} from '@/infrastructure/peer-device/deviceSurface';

function freshTerminalService(): TerminalService {
  (TerminalService as unknown as { instance: TerminalService | null }).instance = null;
  return TerminalService.getInstance();
}

describe('TerminalService device surface switching', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    listenMock.mockReset();
    listenMock.mockReturnValue(() => {});
    resetDeviceSurfaceForTest();
    hostMock.capabilities = null;
    hostMock.listeners.clear();
    replayMock.created.length = 0;
  });

  afterEach(() => {
    resetDeviceSurfaceForTest();
  });

  it('leaves the device being left untouched when a switch disconnects', async () => {
    const unlisten = vi.fn();
    listenMock.mockReturnValue(unlisten);

    const service = freshTerminalService();
    await service.connect();
    invokeMock.mockClear();

    await service.disconnect();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(false);
  });

  it('drops terminal events produced by the device the window left', async () => {
    let emitTerminalEvent: ((payload: unknown) => void) | null = null;
    listenMock.mockImplementation((_event: string, callback: (payload: unknown) => void) => {
      emitTerminalEvent = callback;
      return () => {};
    });

    const service = freshTerminalService();
    await service.connect();

    const events = vi.fn();
    service.onEvent(events);
    activateSurface('peer-device-b');

    emitTerminalEvent?.({
      type: 'Data',
      payload: { session_id: 'pty-on-device-a', data: 'still running there' },
    });

    expect(events).not.toHaveBeenCalled();
  });

  it('rebinds the event stream when connect is called on a new surface', async () => {
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    listenMock
      .mockReturnValueOnce(firstUnlisten)
      .mockReturnValueOnce(secondUnlisten);

    const service = freshTerminalService();
    await service.connect();
    activateSurface('peer-device-b');
    await service.connect();

    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  describe('terminal cursor replay', () => {
    async function connectToHost(capabilities: Record<string, unknown> | null = { terminalCursorReplayV1: true }): Promise<TerminalService> {
      hostMock.capabilities = capabilities;
      activateSurface('peer-host');
      const service = freshTerminalService();
      await service.connect();
      return service;
    }

    it('follows replay pages from where the history ended', async () => {
      const service = await connectToHost();
      invokeMock.mockResolvedValueOnce({ data: 'old', nextOffset: 3 });
      await service.getHistory('t1');
      service.onSessionEvent('t1', vi.fn());

      expect(replayMock.created).toHaveLength(1);
      expect(replayMock.created[0].start).toHaveBeenCalledTimes(1);
      expect(replayMock.created[0].follow).toHaveBeenCalledWith(3);
    });

    it('falls back to host kind for a CLI host that predates the capability', async () => {
      const service = await connectToHost({ hostKind: 'cli' });
      service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created).toHaveLength(1);
    });

    it('keeps Desktop hosts on terminal_event', async () => {
      const service = await connectToHost({ hostKind: 'desktop' });
      invokeMock.mockResolvedValueOnce({ data: 'old', nextOffset: 3 });
      await service.getHistory('t1');
      service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created).toHaveLength(0);
    });

    it('decides again when capabilities resolve after the view subscribed', async () => {
      const service = await connectToHost({ hostKind: null });
      invokeMock.mockResolvedValueOnce({ data: 'old', nextOffset: 7 });
      await service.getHistory('t1');
      service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created).toHaveLength(0);

      hostMock.capabilities = { hostKind: 'cli' };
      hostMock.listeners.forEach(listener => listener());

      expect(replayMock.created).toHaveLength(1);
      expect(replayMock.created[0].follow).toHaveBeenCalledWith(7);
    });

    it('routes replayed output through the same terminal event path', async () => {
      const service = await connectToHost();
      const listener = vi.fn();
      service.onSessionEvent('t1', listener);

      replayMock.created[0].deliver({ type: 'Data', payload: { session_id: 't1', data: 'hello' } });

      expect(listener).toHaveBeenCalledWith({ type: 'output', sessionId: 't1', data: 'hello' });
    });

    it('shares one replay per session and stops it with the last listener', async () => {
      const service = await connectToHost();
      const first = service.onSessionEvent('t1', vi.fn());
      const second = service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created).toHaveLength(1);

      first();
      expect(replayMock.created[0].close).not.toHaveBeenCalled();
      second();
      expect(replayMock.created[0].close).toHaveBeenCalledTimes(1);
    });

    it('does not leave a second view offset behind for the next replay', async () => {
      const service = await connectToHost();
      invokeMock.mockResolvedValueOnce({ data: 'a', nextOffset: 1 });
      await service.getHistory('t1');
      const first = service.onSessionEvent('t1', vi.fn());
      invokeMock.mockResolvedValueOnce({ data: 'ab', nextOffset: 2 });
      await service.getHistory('t1');
      const second = service.onSessionEvent('t1', vi.fn());
      first();
      second();

      service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created[1].follow).toHaveBeenCalledWith(0);
    });

    it('tracks listed tabs without a view and reports their exit to the tab list', async () => {
      const service = await connectToHost();
      const events = vi.fn();
      service.onEvent(events);
      invokeMock.mockResolvedValueOnce([{ id: 't1', workspaceId: 'w', name: 'Shell' }]);
      await service.listSessions();

      expect(replayMock.created).toHaveLength(1);
      expect(replayMock.created[0].follow).not.toHaveBeenCalled();
      replayMock.created[0].deliver({ type: 'Exit', payload: { session_id: 't1', exit_code: 2 } });
      expect(events).toHaveBeenCalledWith({ type: 'exit', sessionId: 't1', exitCode: 2 });
    });

    it('returns a tab to lifecycle tracking when its view unmounts', async () => {
      const service = await connectToHost();
      service.onEvent(vi.fn());
      invokeMock.mockResolvedValueOnce([{ id: 't1', workspaceId: 'w', name: 'Shell' }]);
      await service.listSessions();
      const view = service.onSessionEvent('t1', vi.fn());
      view();

      expect(replayMock.created).toHaveLength(1);
      expect(replayMock.created[0].unfollow).toHaveBeenCalled();
      expect(replayMock.created[0].close).not.toHaveBeenCalled();
    });

    it('stops replaying when the session is destroyed or the surface is left', async () => {
      const service = await connectToHost();
      service.onSessionEvent('t1', vi.fn());
      service.onSessionEvent('t2', vi.fn());

      replayMock.created[0].deliver({ type: 'SessionDestroyed', payload: { session_id: 't1' } });
      expect(replayMock.created[0].close).toHaveBeenCalledTimes(1);

      await service.disconnect();
      expect(replayMock.created[1].close).toHaveBeenCalledTimes(1);
    });
  });
});
