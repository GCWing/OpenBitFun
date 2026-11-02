// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useAIExperienceSettings } from './useAIExperienceSettings';

const service = vi.hoisted(() => ({
  cached: vi.fn(), read: vi.fn(), listeners: new Set<(value: unknown) => void>(),
}));
vi.mock('../services/AIExperienceConfigService', () => ({ aiExperienceConfigService: {
  getCachedSettings: service.cached,
  getSettingsAsync: service.read,
  addChangeListener: (listener: (value: unknown) => void) => {
    service.listeners.add(listener);
    return () => service.listeners.delete(listener);
  },
} }));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Preferences() {
  const { settings, isLoading, isRefreshing, error } = useAIExperienceSettings();
  return <div data-loading={isLoading} data-refreshing={isRefreshing} data-error={Boolean(error)}>
    {settings ? String(settings.enable_agent_companion) : 'pending'}
  </div>;
}

describe('AI settings refresh lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    activateSurface('local');
    service.cached.mockReset().mockReturnValue(null);
    service.read.mockReset();
    service.listeners.clear();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); activateSurface('local'); });

  it('shows warm content immediately and retains it after a failed refresh', async () => {
    service.cached.mockReturnValue({ enable_agent_companion: false });
    const read = deferred();
    service.read.mockReturnValue(read.promise);
    act(() => root.render(<Preferences />));
    expect(container.textContent).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-refreshing')).toBe('true');
    await act(async () => read.reject(new Error('offline')));
    expect(container.textContent).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('true');
  });

  it('does not overwrite a newer configuration notification with a late read', async () => {
    const read = deferred();
    service.read.mockReturnValue(read.promise);
    act(() => root.render(<Preferences />));
    act(() => service.listeners.forEach(listener => listener({ enable_agent_companion: false })));
    await act(async () => read.resolve({ enable_agent_companion: true }));
    expect(container.textContent).toBe('false');
    act(() => root.render(null));
    expect(service.listeners.size).toBe(0);
  });

  it('hides old device data immediately and ignores its late response', async () => {
    service.cached.mockReturnValue({ enable_agent_companion: true });
    const oldRead = deferred();
    const newRead = deferred();
    service.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    act(() => root.render(<Preferences />));
    act(() => activateSurface('peer'));
    expect(container.textContent).toBe('pending');
    await act(async () => oldRead.resolve({ enable_agent_companion: true }));
    expect(container.textContent).toBe('pending');
    await act(async () => newRead.resolve({ enable_agent_companion: false }));
    expect(container.textContent).toBe('false');
  });
});
