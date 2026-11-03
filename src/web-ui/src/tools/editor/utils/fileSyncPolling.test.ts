// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorFileSyncPollInterval, startEditorFileSyncPolling } from './fileSyncPolling';

const state = vi.hoisted(() => ({ peer: false }));
vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => state.peer,
  PEER_MODE_FILE_SYNC_POLL_MS: 15_000,
}));

beforeEach(() => {
  vi.useFakeTimers();
  state.peer = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('editor file sync polling', () => {
  it('preserves direct workspace synchronization and the existing Peer interval', () => {
    expect(editorFileSyncPollInterval()).toBe(1000);
    state.peer = true;
    expect(editorFileSyncPollInterval()).toBe(15_000);
  });

  it('pauses hidden timers and immediately checks external changes on return', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    const tick = vi.fn();
    const stop = startEditorFileSyncPolling(tick, 0);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tick).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tick).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
    }
  });

  it('retires the local warmup when switching to a peer and removes every timer on close', async () => {
    const tick = vi.fn();
    const stop = startEditorFileSyncPolling(tick, 0);
    try {
      await vi.advanceTimersByTimeAsync(100);
      state.peer = true;
      window.dispatchEvent(new Event('peer-mode:changed'));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(tick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
    tick.mockClear();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('peer-mode:changed'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('does not leave a warmup timer after immediate disposal', async () => {
    const tick = vi.fn();
    const stop = startEditorFileSyncPolling(tick, 0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps exactly one interval through repeated visibility and peer transitions', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const tick = vi.fn();
    const stop = startEditorFileSyncPolling(tick, 100);
    try {
      await vi.advanceTimersByTimeAsync(350);
      expect(tick).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 3; index += 1) {
        visibility.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        state.peer = true;
        window.dispatchEvent(new Event('peer-mode:changed'));
        expect(vi.getTimerCount()).toBe(0);
        const calls = tick.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(tick).toHaveBeenCalledTimes(calls);
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(tick).toHaveBeenCalledTimes(calls + 1);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(15_100);
        expect(tick).toHaveBeenCalledTimes(calls + 2);
        state.peer = false;
        window.dispatchEvent(new Event('peer-mode:changed'));
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1100);
        expect(tick).toHaveBeenCalledTimes(calls + 3);
      }
    } finally {
      stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
