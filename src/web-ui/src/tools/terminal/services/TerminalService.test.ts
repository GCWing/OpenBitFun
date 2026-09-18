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
});
