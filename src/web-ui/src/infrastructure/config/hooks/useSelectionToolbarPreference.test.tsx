// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useSelectionToolbarPreference } from './useSelectionToolbarPreference';

const mocks = vi.hoisted(() => ({ get: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../services/ConfigManager', () => ({ configManager: {
  getOptionalConfig: mocks.get,
  watch: (_path: string, listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
} }));

function Preference() {
  const { enabled, error, reload } = useSelectionToolbarPreference();
  return <button data-enabled={String(enabled)} data-error={String(!!error)} onClick={() => void reload()} />;
}

describe('selection toolbar preference loading and device scope', () => {
  let root: Root;
  let container: HTMLDivElement;
  const button = () => container.querySelector('button')!;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    mocks.get.mockReset();
    mocks.listeners.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    activateSurface('local');
  });

  it('waits for initial loading and treats a missing old-host field as enabled', async () => {
    let resolve: (value: undefined) => void = () => {};
    mocks.get.mockReturnValue(new Promise<undefined>(done => { resolve = done; }));
    act(() => root.render(<Preference />));
    expect(button().dataset.enabled).toBe('null');
    await act(async () => resolve(undefined));
    expect(button().dataset.enabled).toBe('true');
  });

  it('does not apply a stale initial read after a newer configuration notification', async () => {
    let resolve: (value: boolean) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    act(() => root.render(<Preference />));
    mocks.get.mockResolvedValue(false);
    await act(async () => mocks.listeners.forEach(listener => listener()));
    await act(async () => resolve(true));
    expect(button().dataset.enabled).toBe('false');
  });

  it('clears the old device snapshot and rejects its pending result after switching devices', async () => {
    mocks.get.mockResolvedValue(false);
    await act(async () => root.render(<Preference />));
    expect(button().dataset.enabled).toBe('false');
    let resolveLocal: (value: boolean) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<boolean>(done => { resolveLocal = done; }));
    act(() => mocks.listeners.forEach(listener => listener()));
    let resolvePeer: (value: undefined) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<undefined>(done => { resolvePeer = done; }));
    act(() => activateSurface('peer-device'));
    expect(button().dataset.enabled).toBe('null');
    await act(async () => resolveLocal(false));
    expect(button().dataset.enabled).toBe('null');
    await act(async () => resolvePeer(undefined));
    expect(button().dataset.enabled).toBe('true');
    expect(mocks.listeners.size).toBe(1);
  });

  it('exposes a read failure for retry instead of substituting an enabled preference', async () => {
    mocks.get.mockRejectedValue(new Error('Host unavailable'));
    await act(async () => root.render(<Preference />));
    expect(button().dataset.enabled).toBe('null');
    expect(button().dataset.error).toBe('true');
    mocks.get.mockResolvedValue(false);
    await act(async () => button().click());
    expect(button().dataset.enabled).toBe('false');
    expect(button().dataset.error).toBe('false');
  });
});
