import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LIVING_LINE_SETTINGS_KEY, loadSettings, saveSettings, validateSettings } from './settings';

describe('LivingLine preview settings', () => {
  it('uses an isolated versioned storage key and defaults', () => {
    expect(LIVING_LINE_SETTINGS_KEY).toBe('openbitfun.living-line.settings.v1');
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it('rejects non-finite, out-of-range and invalid color values', () => {
    expect(() => validateSettings({ flowBlur: Number.NaN })).toThrow();
    expect(() => validateSettings({ idlePeriodSeconds: 0 })).toThrow();
    expect(() => validateSettings({ lineColor: 'red' })).toThrow();
    expect(() => validateSettings({ extra: 1 })).toThrow();
  });
  it('round-trips validated settings and does not persist invalid values', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const candidate = { ...DEFAULT_SETTINGS, flowIntensity: 0.55, flowColor: '#FFFFFF' };
    expect(saveSettings(storage, candidate)).toBe(true);
    expect(loadSettings(storage)).toEqual({ settings: candidate, status: 'loaded' });
    expect(saveSettings(storage, { ...candidate, flowLength: Infinity })).toBe(false);
    expect(loadSettings(storage).settings).toEqual(candidate);
  });
  it('falls back clearly for corrupt persisted data and unavailable storage', () => {
    expect(loadSettings({ getItem: () => '{bad', setItem: () => {} })).toEqual({ settings: DEFAULT_SETTINGS, status: 'invalid' });
    expect(loadSettings({ getItem: () => { throw new Error('denied'); }, setItem: () => {} }).status).toBe('unavailable');
  });
});
