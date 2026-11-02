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

const hostKindMock = vi.hoisted(() => ({ current: null as string | null }));
const replayMock = vi.hoisted(() => ({
  created: [] as Array<{ sessionId: string; offset: number; deliver: (event: unknown) => void; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: {
    get: () => ({ getState: () => ({ capabilities: { hostKind: hostKindMock.current } }) }),
  },
}));
vi.mock('./PeerTerminalReplay', () => ({
  PeerTerminalReplay: class {
    start = vi.fn();
    close = vi.fn();
    constructor(public sessionId: string, public offset: number, public deliver: (event: unknown) => void) {
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
    hostKindMock.current = null;
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

  describe('CLI peer host output', () => {
    async function connectToCliHost(): Promise<TerminalService> {
      hostKindMock.current = 'cli';
      activateSurface('peer-cli');
      const service = freshTerminalService();
      await service.connect();
      return service;
    }

    it('follows replay pages from where the history ended', async () => {
      const service = await connectToCliHost();
      invokeMock.mockResolvedValueOnce({ data: 'old', nextOffset: 3 });
      await service.getHistory('t1');
      service.onSessionEvent('t1', vi.fn());

      expect(replayMock.created).toHaveLength(1);
      expect(replayMock.created[0]).toMatchObject({ sessionId: 't1', offset: 3 });
      expect(replayMock.created[0].start).toHaveBeenCalledTimes(1);
    });

    it('routes replayed output through the same terminal event path', async () => {
      const service = await connectToCliHost();
      const listener = vi.fn();
      service.onSessionEvent('t1', listener);

      replayMock.created[0].deliver({ type: 'Data', payload: { session_id: 't1', data: 'hello' } });

      expect(listener).toHaveBeenCalledWith({ type: 'output', sessionId: 't1', data: 'hello' });
    });

    it('shares one replay per session and stops it with the last listener', async () => {
      const service = await connectToCliHost();
      const first = service.onSessionEvent('t1', vi.fn());
      const second = service.onSessionEvent('t1', vi.fn());
      expect(replayMock.created).toHaveLength(1);

      first();
      expect(replayMock.created[0].close).not.toHaveBeenCalled();
      second();
      expect(replayMock.created[0].close).toHaveBeenCalledTimes(1);
    });

    it('stops replaying when the session is destroyed or the surface is left', async () => {
      const service = await connectToCliHost();
      service.onSessionEvent('t1', vi.fn());
      service.onSessionEvent('t2', vi.fn());

      replayMock.created[0].deliver({ type: 'SessionDestroyed', payload: { session_id: 't1' } });
      expect(replayMock.created[0].close).toHaveBeenCalledTimes(1);

      await service.disconnect();
      expect(replayMock.created[1].close).toHaveBeenCalledTimes(1);
    });

    it('keeps Desktop hosts on terminal_event', async () => {
      hostKindMock.current = 'desktop';
      activateSurface('peer-desktop');
      const service = freshTerminalService();
      await service.connect();
      invokeMock.mockResolvedValueOnce({ data: 'old', nextOffset: 3 });
      await service.getHistory('t1');
      service.onSessionEvent('t1', vi.fn());

      expect(replayMock.created).toHaveLength(0);
    });
  });
});
