// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useDeviceVisibilityPreferences as preferences } from './deviceVisibilityPreferences';

const storageKey = 'openbitfun.sidebar-device-visibility.v1';

describe('controller device visibility preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    preferences.setState({ hidden: {} });
  });

  it.each([undefined, {}, { expanded: { local: false } }, { hidden: null }])(
    'keeps every device visible with absent or legacy preferences: %j', async state => {
      if (state === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify({ state, version: 0 }));
      await preferences.persist.rehydrate();
      expect(preferences.getState().hidden).toEqual({});
    },
  );

  it('round-trips visibility without sharing state between different device IDs', async () => {
    preferences.getState().setVisible('local', false);
    preferences.getState().setVisible('peer-a', false);
    preferences.getState().setVisible('peer-b', true);
    const saved = localStorage.getItem(storageKey)!;
    preferences.setState({ hidden: {} });
    localStorage.setItem(storageKey, saved);
    await preferences.persist.rehydrate();
    expect(preferences.getState().hidden).toEqual({ local: true, 'peer-a': true, 'peer-b': false });
    preferences.getState().setVisible('peer-a', true);
    expect(preferences.getState().hidden.local).toBe(true);
    expect(preferences.getState().hidden['peer-b']).toBe(false);
  });

  it('ignores unknown values without modifying the saved record during hydration', async () => {
    const saved = JSON.stringify({ state: { hidden: { local: true, 'peer-a': 'hidden', 'peer-b': false } }, version: 0 });
    localStorage.setItem(storageKey, saved);
    await preferences.persist.rehydrate();
    expect(preferences.getState().hidden).toEqual({ local: true, 'peer-b': false });
    expect(localStorage.getItem(storageKey)).toBe(saved);
  });
});
