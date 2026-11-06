// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_LINK_TARGET_STORAGE_KEY, browserLinkPreferenceStore, createBrowserLinkPreferenceStore } from './browserLinkPreference';

function storage(value: string | null = null) {
  let saved = value;
  return { getItem: () => saved, setItem: vi.fn((_key: string, next: string) => { saved = next; }) };
}

describe('controller browser link preference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(BROWSER_LINK_TARGET_STORAGE_KEY);
    browserLinkPreferenceStore.setState({ target: 'builtin' });
  });

  it.each([null, '', 'builtin', 'future-target'])('reads an older or unknown record %j without rewriting it', value => {
    const persisted = storage(value);
    expect(createBrowserLinkPreferenceStore(persisted).getState().target).toBe('builtin');
    expect(persisted.getItem()).toBe(value);
    expect(persisted.setItem).not.toHaveBeenCalled();
  });

  it('round-trips both choices across window restarts', () => {
    const persisted = storage();
    createBrowserLinkPreferenceStore(persisted).getState().setTarget('external');
    expect(persisted.setItem).toHaveBeenCalledWith(BROWSER_LINK_TARGET_STORAGE_KEY, 'external');
    const reopened = createBrowserLinkPreferenceStore(persisted);
    expect(reopened.getState().target).toBe('external');
    reopened.getState().setTarget('builtin');
    expect(createBrowserLinkPreferenceStore(persisted).getState().target).toBe('builtin');
  });

  it('keeps links usable when storage cannot be read or written', () => {
    const store = createBrowserLinkPreferenceStore({
      getItem: () => { throw Error('unavailable'); },
      setItem: () => { throw Error('unavailable'); },
    });
    expect(store.getState().target).toBe('builtin');
    store.getState().setTarget('external');
    expect(store.getState().target).toBe('external');
  });

  it('follows the latest choice from another window without writing it back', () => {
    localStorage.setItem(BROWSER_LINK_TARGET_STORAGE_KEY, 'external');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    window.dispatchEvent(new StorageEvent('storage', {
      storageArea: localStorage, key: BROWSER_LINK_TARGET_STORAGE_KEY, newValue: 'builtin',
    }));
    expect(browserLinkPreferenceStore.getState().target).toBe('external');
    expect(write).not.toHaveBeenCalled();

    localStorage.removeItem(BROWSER_LINK_TARGET_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: null }));
    expect(browserLinkPreferenceStore.getState().target).toBe('builtin');
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys and session storage events', () => {
    browserLinkPreferenceStore.setState({ target: 'external' });
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: 'other-preference' }));
    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: BROWSER_LINK_TARGET_STORAGE_KEY }));
    expect(browserLinkPreferenceStore.getState().target).toBe('external');
  });

  it('preserves the current choice when a cross-window refresh cannot read storage', () => {
    browserLinkPreferenceStore.setState({ target: 'external' });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('unavailable'); });
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: BROWSER_LINK_TARGET_STORAGE_KEY }));
    expect(browserLinkPreferenceStore.getState().target).toBe('external');
  });
});
