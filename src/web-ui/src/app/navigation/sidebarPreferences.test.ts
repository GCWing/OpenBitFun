import { describe, expect, it } from 'vitest';
import { createSidebarPreferences, isVisibleSidebarPin, SIDEBAR_PREFERENCES_KEY } from './sidebarPreferences';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (_key: string) => value,
    setItem: (key: string, next: string) => { expect(key).toBe(SIDEBAR_PREFERENCES_KEY); value = next; },
  };
}

describe('controller sidebar preferences', () => {
  it('retains the retired import pin on disk without interrupting visible ordering', () => {
    const storage = memoryStorage(JSON.stringify({ version: 1, pinnedIds: ['builtin.todos', 'builtin.external-import', 'builtin.miniapps'] }));
    const store = createSidebarPreferences(storage);
    store.getState().move('builtin.miniapps', -1);
    expect(store.getState().pinnedIds.filter(isVisibleSidebarPin)).toEqual(['builtin.miniapps', 'builtin.todos']);
    expect(createSidebarPreferences(storage).getState().pinnedIds).toEqual(['builtin.miniapps', 'builtin.external-import', 'builtin.todos']);
  });

  it('keeps the existing default layout and persists an intentionally empty selection', () => {
    const storage = memoryStorage();
    const store = createSidebarPreferences(storage);
    expect(store.getState().pinnedIds).toEqual(['builtin.todos']);
    store.getState().setPinned('builtin.todos', false);
    expect(createSidebarPreferences(storage).getState().pinnedIds).toEqual([]);
    store.getState().reset();
    expect(createSidebarPreferences(storage).getState().pinnedIds).toEqual(['builtin.todos']);
  });

  it('round-trips older payloads, unknown entries and additive fields without dropping them', () => {
    const storage = memoryStorage(JSON.stringify({ pinnedIds: ['extension.future', 'builtin.todos', 'builtin.todos'], extra: { retained: true } }));
    const store = createSidebarPreferences(storage);
    store.getState().setPinned('builtin.external-import', true);
    store.getState().move('builtin.external-import', -1);
    expect(createSidebarPreferences(storage).getState().pinnedIds)
      .toEqual(['extension.future', 'builtin.external-import', 'builtin.todos']);
    expect(JSON.parse(storage.getItem('')!)).toEqual({
      version: 1, pinnedIds: ['extension.future', 'builtin.external-import', 'builtin.todos'], extra: { retained: true },
    });
  });

  it.each(['{broken', JSON.stringify({ version: 9, pinnedIds: ['extension.future'] }), JSON.stringify({ version: 1, pinnedIds: [42] })])(
    'preserves unreadable data until an explicit reset: %s', saved => {
      const storage = memoryStorage(saved);
      const store = createSidebarPreferences(storage);
      expect(store.getState().storageIssue).not.toBeNull();
      store.getState().setPinned('builtin.external-import', true);
      expect(storage.getItem('')).toBe(saved);
      store.getState().reset();
      expect(store.getState().storageIssue).toBeNull();
      expect(createSidebarPreferences(storage).getState().pinnedIds).toEqual(['builtin.todos']);
    },
  );

  it('reports a failed write without claiming the changed layout was saved', () => {
    const storage = memoryStorage();
    const store = createSidebarPreferences({ ...storage, setItem: () => { throw new Error('full'); } });
    store.getState().setPinned('builtin.external-import', true);
    expect(store.getState()).toMatchObject({ pinnedIds: ['builtin.todos'], storageIssue: 'write' });
    expect(storage.getItem('')).toBeNull();
  });

  it('does not wrap ordering at either boundary or duplicate pins', () => {
    const store = createSidebarPreferences(memoryStorage());
    store.getState().setPinned('builtin.todos', true);
    store.getState().move('builtin.todos', -1);
    store.getState().move('builtin.todos', 1);
    store.getState().move('missing', 1);
    expect(store.getState().pinnedIds).toEqual(['builtin.todos']);
  });
});
