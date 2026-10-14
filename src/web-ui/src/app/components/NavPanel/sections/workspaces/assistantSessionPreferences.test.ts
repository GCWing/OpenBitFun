import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: mocks.read } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { updateConfig: mocks.update } }));
vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: (key: string) => key } }));

import { readAssistantDefaultSession, saveAssistantDefaultSession } from './assistantSessionPreferences';

beforeEach(() => {
  vi.resetAllMocks();
  resetDeviceSurfaceForTest();
});

describe('host-owned assistant default preferences', () => {
  it('treats a missing contract on an older host as unsupported without assuming an empty write target', async () => {
    mocks.read.mockResolvedValue(undefined);
    expect(await readAssistantDefaultSession('a')).toEqual({ supported: false, sessionId: null });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reads the current host each time and isolates preferences by workspace', async () => {
    mocks.read.mockResolvedValueOnce({ a: 'first', b: 'second' }).mockResolvedValueOnce({ a: 'peer-default' });
    expect(await readAssistantDefaultSession('a')).toEqual({ supported: true, sessionId: 'first' });
    activateSurface('peer');
    expect(await readAssistantDefaultSession('a')).toEqual({ supported: true, sessionId: 'peer-default' });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('sets and clears only the requested assistant in a fresh host map', async () => {
    const original = { a: 'first', b: 'second' };
    const saved: Record<string, string>[] = [];
    mocks.update.mockImplementation(async (_path, edit) => saved.push(edit(original)));
    await saveAssistantDefaultSession('a', 'next');
    await saveAssistantDefaultSession('a', null);
    expect(saved).toEqual([{ a: 'next', b: 'second' }, { b: 'second' }]);
    expect(original).toEqual({ a: 'first', b: 'second' });
  });

  it('rejects unreadable and unavailable config without replacing it', async () => {
    mocks.read.mockRejectedValueOnce(new Error('Host offline'));
    await expect(readAssistantDefaultSession('a')).rejects.toThrow('Host offline');
    mocks.update.mockImplementation(async (_path, edit) => edit({ a: { unknown: true } }));
    await expect(saveAssistantDefaultSession('a', 'next')).rejects.toThrow('defaultReadFailed');
  });

  it('discards reads completed after a surface switch', async () => {
    mocks.read.mockImplementation(async () => {
      activateSurface('peer');
      return { a: 'old-surface' };
    });
    await expect(readAssistantDefaultSession('a')).rejects.toThrow('Device surface changed');
  });
});
