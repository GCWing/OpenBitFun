/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { useMiniAppNavigationStore } from './miniAppNavigationStore';

const store = useMiniAppNavigationStore;
const storageKey = 'openbitfun-miniapp-navigation';

beforeEach(() => {
  localStorage.clear();
  store.setState({ pinnedAppIdsBySurface: {} });
});

describe('MiniApp navigation preferences', () => {
  it('keeps insertion order, ignores duplicate additions, and isolates equal app IDs by device', () => {
    const { setPinned } = store.getState();
    setPinned('local', 'notes', true);
    setPinned('local', 'timer', true);
    setPinned('local', 'notes', true);
    setPinned('peer', 'notes', true);
    setPinned('local', 'notes', false);
    expect(store.getState().pinnedAppIdsBySurface).toEqual({ local: ['timer'], peer: ['notes'] });
    setPinned('local', 'notes', true);
    expect(store.getState().pinnedAppIdsBySurface.local).toEqual(['timer', 'notes']);
  });

  it('restores the saved preferences after a reload without persisting actions', async () => {
    store.getState().setPinned('peer', 'notes', true);
    const saved = localStorage.getItem(storageKey)!;
    expect(JSON.parse(saved).state).toEqual({ pinnedAppIdsBySurface: { peer: ['notes'] } });
    store.setState({ pinnedAppIdsBySurface: {} });
    localStorage.setItem(storageKey, saved);
    await store.persist.rehydrate();
    expect(store.getState().pinnedAppIdsBySurface).toEqual({ peer: ['notes'] });
    store.getState().setPinned('peer', 'timer', true);
    expect(store.getState().pinnedAppIdsBySurface.peer).toEqual(['notes', 'timer']);
  });

  it('accepts older empty preferences and tolerates unknown payload fields', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ state: {}, version: 0 }));
    await store.persist.rehydrate();
    expect(store.getState().pinnedAppIdsBySurface).toEqual({});
    localStorage.setItem(storageKey, JSON.stringify({ state: {
      pinnedAppIdsBySurface: { local: ['notes'], peer: ['timer'] }, futureSetting: true,
    }, version: 0 }));
    await store.persist.rehydrate();
    store.getState().setPinned('local', 'timer', true);
    expect(JSON.parse(localStorage.getItem(storageKey)!).state.pinnedAppIdsBySurface)
      .toEqual({ local: ['notes', 'timer'], peer: ['timer'] });
  });
});
