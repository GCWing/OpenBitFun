// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisualSkinStorage } from './storage';
import { VisualSkinPackageParser } from './parser';
import { VisualSkinRuntime } from './runtime';

const packageSource = {
  manifest: {
    schema: 'openbitfun.visual-skin',
    schemaVersion: 1,
    id: 'stored-skin',
    name: 'Stored Skin',
    version: '1.0.0',
    previewAssetId: 'preview',
  },
  modes: { light: { tokens: { 'color.content.primary': '#123456' } } },
  assets: {
    preview: {
      mimeType: 'image/svg+xml',
      source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' },
    },
  },
};

// Exercise the adapter with asynchronous IndexedDB requests and transaction
// completion. The maps belong to the test host, never to production storage.
function createIndexedDbFixture() {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const failures = { deleteStore: null as string | null, selectionWrite: false };
  const database = {
    createObjectStore(name: string) { stores.set(name, new Map()); },
    transaction(names: string | string[], mode = 'readonly') {
      const scopedNames = typeof names === 'string' ? [names] : names;
      const staged = new Map(scopedNames.map(name => [name, new Map(stores.get(name)!)]));
      let pending = 0;
      let aborted = false;
      const transaction = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore(name: string) {
          const store = staged.get(name);
          if (!store) throw new Error(`Store is outside this transaction: ${name}`);
          return {
            get: (key: IDBValidKey) => request(() => structuredClone(store.get(key))),
            put: (value: unknown, key: IDBValidKey) => request(() => {
              if (name === 'selection' && failures.selectionWrite) throw new Error('Injected selection write failure');
              store.set(key, structuredClone(value));
            }),
            delete: (key: IDBValidKey) => request(() => {
              if (failures.deleteStore === name) throw new Error(`Injected ${name} delete failure`);
              store.delete(key);
            }),
            openCursor: () => {
              const entries = [...store.entries()];
              let index = 0;
              const cursorRequest = { result: null as unknown, onsuccess: null as (() => void) | null };
              const next = () => schedule(() => {
                const entry = entries[index++];
                cursorRequest.result = entry ? { key: entry[0], value: structuredClone(entry[1]), continue: next } : null;
                cursorRequest.onsuccess?.();
              });
              next();
              return cursorRequest;
            },
          };
        },
      };
      function schedule(operation: () => void) {
        pending++;
        queueMicrotask(() => {
          if (aborted) return;
          try { operation(); }
          catch (error) {
            aborted = true;
            transaction.error = error as Error;
            transaction.onerror?.();
            transaction.onabort?.();
            return;
          }
          if (--pending === 0) {
            if (mode === 'readwrite') staged.forEach((store, name) => stores.set(name, store));
            transaction.oncomplete?.();
          }
        });
      }
      function request(operation: () => unknown) {
        const result = { result: undefined as unknown, onsuccess: null as (() => void) | null };
        schedule(() => { result.result = operation(); result.onsuccess?.(); });
        return result;
      }
      return transaction;
    },
  };
  const open = vi.fn(() => {
    const pending = { result: database, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null };
    queueMicrotask(() => {
      if (stores.size === 0) pending.onupgradeneeded?.();
      pending.onsuccess?.();
    });
    return pending;
  });
  return { indexedDB: { open }, stores, failures };
}

async function parsedSkin() {
  return new VisualSkinPackageParser().parse(new TextEncoder().encode(JSON.stringify(packageSource)).buffer);
}

describe('visual skin IndexedDB storage', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('persists packages and selection across storage instances, and removes them explicitly', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const skin = await parsedSkin();
    const storage = createVisualSkinStorage();
    await storage.put(skin);
    await storage.setSelection(skin.manifest.id);

    const reopened = createVisualSkinStorage();
    expect(await reopened.list()).toEqual({ skins: [skin], invalidRecords: [] });
    expect(await reopened.get(skin.manifest.id)).toEqual(skin);
    expect(await reopened.getSelection()).toBe(skin.manifest.id);
    await reopened.delete(skin.manifest.id);
    expect(await reopened.getSelection()).toBeNull();
    expect(await reopened.list()).toEqual({ skins: [], invalidRecords: [] });
    expect(await reopened.get(skin.manifest.id)).toBeNull();
    expect(await reopened.getSelection()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('reports unavailable persistence without falling back to localStorage or memory', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const runtime = new VisualSkinRuntime();
    await runtime.initialize();
    expect(runtime.getSnapshot()).toMatchObject({ initialized: true, status: 'degraded' });
    expect(runtime.getSnapshot().error).toContain('IndexedDB is unavailable');
    await expect(createVisualSkinStorage().put(await parsedSkin())).rejects.toThrow('IndexedDB is unavailable');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects tampered stored CSS and preserves the invalid record for explicit removal', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const skin = await parsedSkin();
    const storage = createVisualSkinStorage();
    await storage.put(skin);
    const tampered = { ...skin, modes: { light: { tokens: { 'color.content.primary': 'red; color:red' } } } };
    fixture.stores.get('packages')!.set(skin.manifest.id, tampered);
    await expect(storage.get(skin.manifest.id)).rejects.toThrow('forbidden CSS');
    expect(await storage.list()).toMatchObject({ skins: [], invalidRecords: [{ key: skin.manifest.id, error: expect.stringContaining('forbidden CSS') }] });
    expect(fixture.stores.get('packages')!.get(skin.manifest.id)).toEqual(tampered);
  });

  it('rejects missing metadata and mismatched materialized assets instead of repairing them', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const skin = await parsedSkin();
    const storage = createVisualSkinStorage();
    await storage.put(skin);
    fixture.stores.get('packages')!.set(skin.manifest.id, { ...skin, importedAt: undefined });
    await expect(storage.get(skin.manifest.id)).rejects.toThrow('metadata is invalid');
    const mismatched = structuredClone(skin);
    mismatched.assets.preview.dataUrl = 'data:image/svg+xml;base64,c2NyaXB0';
    fixture.stores.get('packages')!.set(skin.manifest.id, mismatched);
    await expect(storage.get(skin.manifest.id)).rejects.toThrow('asset is invalid');
    expect(fixture.stores.get('packages')!.get(skin.manifest.id)).toEqual(mismatched);
  });
  it('isolates a broken record while restoring, activating and importing valid packages', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const a = await parsedSkin();
    const b = { ...a, manifest: { ...a.manifest, id: 'second' } };
    await storage.put(a);
    await storage.put(b);
    const broken = { ...a, importedAt: undefined };
    fixture.stores.get('packages')!.set('broken-key', broken);
    await storage.setSelection(a.manifest.id);
    const runtime = new VisualSkinRuntime(storage);
    try {
      await runtime.initialize();
      expect(runtime.getSnapshot().catalog.map(item => item.id)).toEqual([a.manifest.id, b.manifest.id]);
      expect(runtime.getSnapshot().invalidRecords).toEqual([{ key: 'broken-key', error: 'Stored visual skin metadata is invalid' }]);
      expect(runtime.getSnapshot().activeSkinId).toBe(a.manifest.id);
      await runtime.activate(b.manifest.id);
      expect(runtime.getSnapshot().activeSkinId).toBe(b.manifest.id);
      const imported = { ...packageSource, manifest: { ...packageSource.manifest, id: 'third' } };
      await runtime.importPackage(new TextEncoder().encode(JSON.stringify(imported)).buffer);
      expect(runtime.getSnapshot().catalog).toHaveLength(3);
      expect(runtime.getSnapshot().activeSkinId).toBe('third');
      expect(fixture.stores.get('packages')!.get('broken-key')).toEqual(broken);
      await runtime.remove('broken-key');
      expect(runtime.getSnapshot().invalidRecords).toEqual([]);
      expect(fixture.stores.get('packages')!.has('broken-key')).toBe(false);
      expect(runtime.getSnapshot().catalog).toHaveLength(3);
      expect(runtime.getSnapshot().activeSkinId).toBe('third');
    } finally { runtime.dispose(); }
  });

  it('keeps an invalid selected record and its selection until an explicit user action', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const good = await parsedSkin();
    await storage.put(good);
    const broken = { ...good, importedAt: undefined };
    fixture.stores.get('packages')!.set('bad-selection', broken);
    await storage.setSelection('bad-selection');
    const runtime = new VisualSkinRuntime(storage);
    try {
      await runtime.initialize();
      expect(runtime.getSnapshot()).toMatchObject({ initialized: true, status: 'degraded', activeSkinId: null });
      expect(runtime.getSnapshot().catalog).toHaveLength(1);
      expect(runtime.getSnapshot().invalidRecords[0].key).toBe('bad-selection');
      expect(await storage.getSelection()).toBe('bad-selection');
      expect(fixture.stores.get('packages')!.get('bad-selection')).toEqual(broken);
      await runtime.activate(good.manifest.id);
      expect(runtime.getSnapshot().activeSkinId).toBe(good.manifest.id);
      expect(fixture.stores.get('packages')!.get('bad-selection')).toEqual(broken);
    } finally { runtime.dispose(); }
  });

  it.each(['packages', 'selection'])('rolls back both stores when deletion fails in %s', async storeName => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const a = await parsedSkin();
    const b = { ...a, manifest: { ...a.manifest, id: 'second' } };
    await storage.put(a);
    await storage.put(b);
    await storage.setSelection(a.manifest.id);
    fixture.failures.deleteStore = storeName;
    await expect(storage.delete(a.manifest.id)).rejects.toThrow(`Injected ${storeName} delete failure`);
    expect(await storage.get(a.manifest.id)).toEqual(a);
    expect(await storage.get(b.manifest.id)).toEqual(b);
    expect(await storage.getSelection()).toBe(a.manifest.id);
    fixture.failures.deleteStore = null;
    await storage.delete(a.manifest.id);
    expect(await storage.get(a.manifest.id)).toBeNull();
    expect(await storage.getSelection()).toBeNull();
    expect(await storage.get(b.manifest.id)).toEqual(b);
  });

  it('deletes an unrelated package without attempting to clear the active selection', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const a = await parsedSkin();
    const b = { ...a, manifest: { ...a.manifest, id: 'second' } };
    await storage.put(a);
    await storage.put(b);
    await storage.setSelection(a.manifest.id);
    fixture.failures.deleteStore = 'selection';
    await storage.delete(b.manifest.id);
    expect(await storage.getSelection()).toBe(a.manifest.id);
    expect(await storage.get(a.manifest.id)).toEqual(a);
    expect(await storage.get(b.manifest.id)).toBeNull();
  });

  it('restores preview using the production runtime and adapter without rewriting selection', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const a = await parsedSkin();
    const b = { ...a, manifest: { ...a.manifest, id: 'second' }, modes: { light: { tokens: { 'color.content.primary': '#abcdef' } } } };
    await storage.put(a);
    await storage.put(b);
    const runtime = new VisualSkinRuntime(storage);
    try {
      await runtime.activate(a.manifest.id);
      await runtime.preview(b.manifest.id);
      fixture.failures.selectionWrite = true;
      await runtime.remove(b.manifest.id);
      expect(await storage.get(b.manifest.id)).toBeNull();
      expect(await storage.getSelection()).toBe(a.manifest.id);
      expect(runtime.getSnapshot()).toMatchObject({ activeSkinId: a.manifest.id, previewSkinId: null, status: 'ready' });
      expect(runtime.getSnapshot().catalog.map(item => item.id)).toEqual([a.manifest.id]);
      expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe(a.manifest.id);
      expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#123456');
    } finally { runtime.dispose(); }
  });

  it('preserves the active runtime display when selection clearing aborts the deletion transaction', async () => {
    const fixture = createIndexedDbFixture();
    vi.stubGlobal('indexedDB', fixture.indexedDB);
    const storage = createVisualSkinStorage();
    const a = await parsedSkin();
    await storage.put(a);
    const runtime = new VisualSkinRuntime(storage);
    try {
      await runtime.activate(a.manifest.id);
      const before = runtime.getSnapshot();
      const css = document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent;
      fixture.failures.deleteStore = 'selection';
      await expect(runtime.remove(a.manifest.id)).rejects.toThrow('Injected selection delete failure');
      expect(await storage.get(a.manifest.id)).toEqual(a);
      expect(await storage.getSelection()).toBe(a.manifest.id);
      expect(runtime.getSnapshot()).toEqual({ ...before, error: 'Injected selection delete failure' });
      expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe(a.manifest.id);
      expect(document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent).toBe(css);
      expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#123456');
    } finally { runtime.dispose(); }
  });

});
