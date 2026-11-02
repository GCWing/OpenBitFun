import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIExperienceSettings } from './AIExperienceConfigService';

const tauriCore = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const tauriEvent = vi.hoisted(() => ({
  emit: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCore.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: tauriEvent.emit,
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settings(
  enableAgentCompanion: boolean,
): AIExperienceSettings {
  return {
    enable_session_title_generation: true,
    enable_agent_companion: enableAgentCompanion,
    enable_workspace_search: false,
    quick_actions: [],
  };
}

describe('syncAgentCompanionDesktopWindow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('skips stale queued show or hide requests so the latest config wins', async () => {
    const firstInvoke = deferred<void>();
    tauriCore.invoke
      .mockReturnValueOnce(firstInvoke.promise)
      .mockResolvedValue(undefined);

    const { syncAgentCompanionDesktopWindow } = await import('./AgentCompanionWindowService');

    const first = syncAgentCompanionDesktopWindow(settings(true));
    await vi.waitFor(() => {
      expect(tauriCore.invoke).toHaveBeenCalledTimes(1);
    });

    const staleHide = syncAgentCompanionDesktopWindow(settings(false));
    const latestShow = syncAgentCompanionDesktopWindow(settings(true));

    firstInvoke.resolve();
    await Promise.all([first, staleHide, latestShow]);

    expect(tauriCore.invoke.mock.calls.map(call => call[0])).toEqual([
      'show_agent_companion_desktop_pet',
      'show_agent_companion_desktop_pet',
    ]);
    expect(tauriEvent.emit).toHaveBeenCalledTimes(1);
    expect(tauriEvent.emit).toHaveBeenCalledWith(
      'agent-companion://settings-updated',
      expect.objectContaining({
        enable_agent_companion: true,
      }),
    );
  });

  it('hides the desktop pet when the companion is disabled', async () => {
    const { syncAgentCompanionDesktopWindow } = await import('./AgentCompanionWindowService');

    await syncAgentCompanionDesktopWindow(settings(false));

    expect(tauriCore.invoke.mock.calls.map(call => call[0])).toEqual([
      'hide_agent_companion_desktop_pet',
    ]);
    expect(tauriEvent.emit).not.toHaveBeenCalled();
  });

  it('runs a latest hide after an in-flight stale show without emitting stale settings', async () => {
    const firstInvoke = deferred<void>();
    tauriCore.invoke
      .mockReturnValueOnce(firstInvoke.promise)
      .mockResolvedValue(undefined);

    const { syncAgentCompanionDesktopWindow } = await import('./AgentCompanionWindowService');

    const staleShow = syncAgentCompanionDesktopWindow(settings(true));
    await vi.waitFor(() => {
      expect(tauriCore.invoke).toHaveBeenCalledTimes(1);
    });

    const latestHide = syncAgentCompanionDesktopWindow(settings(false));

    firstInvoke.resolve();
    await Promise.all([staleShow, latestHide]);

    expect(tauriCore.invoke.mock.calls.map(call => call[0])).toEqual([
      'show_agent_companion_desktop_pet',
      'hide_agent_companion_desktop_pet',
    ]);
    expect(tauriEvent.emit).not.toHaveBeenCalled();
  });
});
