// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useChatInputSendPreference } from './useChatInputSendPreference';
import { getChatInputSendDuringTurn } from '../services/ChatInputSendPreference';

const mocks = vi.hoisted(() => ({ get: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: () => false, getCachedConfig: () => undefined,
  getOptionalConfig: mocks.get,
  watch: (_path: string, listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
} }));

function Preference() {
  const { behavior, error, reload } = useChatInputSendPreference();
  return <button data-behavior={String(behavior)} data-error={String(!!error)} onClick={() => void reload()} />;
}

describe('chat input send preference and device scope', () => {
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
  afterEach(() => { act(() => root.unmount()); container.remove(); activateSurface('local'); });

  it.each([undefined, 'immediate', 'future_policy'])('defaults a missing or future policy (%s) to immediate', async value => {
    mocks.get.mockResolvedValue(value);
    expect(await getChatInputSendDuringTurn()).toBe('immediate');
    expect(mocks.get).toHaveBeenCalledWith('app.flow_chat.send_during_turn');
  });

  it('waits for loading before presenting the default', async () => {
    let resolve: (value: undefined) => void = () => {};
    mocks.get.mockReturnValue(new Promise<undefined>(done => { resolve = done; }));
    act(() => root.render(<Preference />));
    expect(button().dataset.behavior).toBe('null');
    await act(async () => resolve(undefined));
    expect(button().dataset.behavior).toBe('immediate');
  });

  it('rejects a stale read after a newer config notification', async () => {
    let resolve: (value: string) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
    act(() => root.render(<Preference />));
    mocks.get.mockResolvedValue('queue');
    await act(async () => mocks.listeners.forEach(listener => listener()));
    await act(async () => resolve('immediate'));
    expect(button().dataset.behavior).toBe('queue');
  });

  it('clears the old device value and rejects its pending read after a switch', async () => {
    mocks.get.mockResolvedValue('queue');
    await act(async () => root.render(<Preference />));
    expect(button().dataset.behavior).toBe('queue');
    let resolveLocal: (value: string) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<string>(done => { resolveLocal = done; }));
    act(() => mocks.listeners.forEach(listener => listener()));
    let resolvePeer: (value: undefined) => void = () => {};
    mocks.get.mockReturnValueOnce(new Promise<undefined>(done => { resolvePeer = done; }));
    act(() => activateSurface('peer-device'));
    expect(button().dataset.behavior).toBe('null');
    await act(async () => resolveLocal('queue'));
    expect(button().dataset.behavior).toBe('null');
    await act(async () => resolvePeer(undefined));
    expect(button().dataset.behavior).toBe('immediate');
    expect(mocks.listeners.size).toBe(1);
  });

  it('shows a failed read instead of applying defaults, and allows retry', async () => {
    mocks.get.mockRejectedValue(new Error('Host unavailable'));
    await act(async () => root.render(<Preference />));
    expect(button().dataset.behavior).toBe('null');
    expect(button().dataset.error).toBe('true');
    mocks.get.mockResolvedValue('queue');
    await act(async () => button().click());
    expect(button().dataset.behavior).toBe('queue');
    expect(button().dataset.error).toBe('false');
  });
});
