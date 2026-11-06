import { describe, expect, it, vi } from 'vitest';
import { BROWSER_LINK_TARGET_STORAGE_KEY, createBrowserLinkPreferenceStore } from './browserLinkPreference';

function storage(value: string | null = null) {
  let saved = value;
  return { getItem: () => saved, setItem: vi.fn((_key: string, next: string) => { saved = next; }) };
}

describe('controller browser link preference', () => {
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
});
