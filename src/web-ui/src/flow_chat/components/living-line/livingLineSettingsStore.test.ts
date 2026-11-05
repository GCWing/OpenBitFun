// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVING_LINE_SETTINGS_KEY,
  readLivingLineSettings,
  saveLivingLineSettings,
  subscribeLivingLineSettings,
} from './livingLineSettingsStore';
import { DEFAULT_SETTINGS } from './settings';

describe('LivingLine settings store', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('reads defaults when storage is empty or corrupt', () => {
    expect(readLivingLineSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem(LIVING_LINE_SETTINGS_KEY, '{bad');
    expect(readLivingLineSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves and reads a validated patch', () => {
    const next = saveLivingLineSettings({ lineWidth: 5 });
    expect(next.lineWidth).toBe(5);
    expect(readLivingLineSettings().lineWidth).toBe(5);
  });

  it('throws instead of falsely succeeding on invalid or unavailable storage', () => {
    expect(() => saveLivingLineSettings({ lineWidth: 999 })).toThrow();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveLivingLineSettings({ flowBlur: 2 })).toThrow();
    setItem.mockRestore();
  });

  it('notifies listeners for same-window custom events', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLivingLineSettings(listener);
    saveLivingLineSettings({ flowWidth: 3 });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies listeners on storage removal and clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLivingLineSettings(listener);
    localStorage.removeItem(LIVING_LINE_SETTINGS_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: LIVING_LINE_SETTINGS_KEY, newValue: null }));
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies listeners on focus', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLivingLineSettings(listener);
    window.dispatchEvent(new Event('focus'));
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('supports BroadcastChannel cross-window notifications when available', async () => {
    if (typeof BroadcastChannel === 'undefined') return;
    const listener = vi.fn();
    const unsubscribe = subscribeLivingLineSettings(listener);
    const channel = new BroadcastChannel('openbitfun-living-line-settings');
    channel.postMessage('changed');
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    channel.close();
    unsubscribe();
  });
});