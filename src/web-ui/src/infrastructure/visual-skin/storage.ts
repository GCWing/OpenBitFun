import { assertValidVisualSkinPackage } from './validator';
import type { StoredVisualSkin, VisualSkinCatalogEntry, InvalidVisualSkinRecord } from './types';

function readStoredVisualSkin(value: unknown): StoredVisualSkin | null {
  if (value === undefined) return null;
  assertValidVisualSkinPackage(value);
  const skin = value as StoredVisualSkin;
  if (typeof skin.importedAt !== 'string' || !skin.assets) {
    throw new Error('Stored visual skin metadata is invalid');
  }
  for (const [id, asset] of Object.entries(skin.assets)) {
    // Only the materialized package written by the importer is a stored skin.
    // Validate it without filling missing fields or rewriting the record.
    if (asset.id !== id || asset.source.kind !== 'data' || asset.dataUrl !== asset.source.data) {
      throw new Error(`Stored visual skin asset is invalid: ${id}`);
    }
  }
  return skin;
}

export interface VisualSkinStorageListing {
  skins: StoredVisualSkin[];
  invalidRecords: InvalidVisualSkinRecord[];
}

export interface VisualSkinStorage {
  list(): Promise<VisualSkinStorageListing>;
  get(id: string): Promise<StoredVisualSkin | null>;
  put(value: StoredVisualSkin): Promise<void>;
  /** Atomically remove the package and clear the selection only if it points to this key. */
  delete(id: IDBValidKey): Promise<void>;
  getSelection(): Promise<string | null>;
  setSelection(id: string | null): Promise<void>;
}

const INDEXED_DB_NAME = 'openbitfun.visual-skin';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_STORE = 'packages';
const INDEXED_DB_SELECTION = 'selection';

class IndexedDbVisualSkinStorage implements VisualSkinStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      if (typeof globalThis.indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable; visual skin storage requires IndexedDB'));
        return;
      }
      const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore(INDEXED_DB_STORE);
        database.createObjectStore(INDEXED_DB_SELECTION);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open visual skin storage'));
    });
    return this.databasePromise;
  }

  async list(): Promise<VisualSkinStorageListing> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const result: VisualSkinStorageListing = { skins: [], invalidRecords: [] };
      const transaction = database.transaction(INDEXED_DB_STORE, 'readonly');
      const request = transaction.objectStore(INDEXED_DB_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(result); return; }
        try {
          const skin = readStoredVisualSkin(cursor.value);
          if (!skin || skin.manifest.id !== cursor.key) throw new Error('Stored visual skin key does not match its manifest');
          result.skins.push(skin);
        } catch (error) {
          result.invalidRecords.push({ key: cursor.key, error: error instanceof Error ? error.message : String(error) });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to list visual skins'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to list visual skins'));
    });
  }

  async get(id: string): Promise<StoredVisualSkin | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(INDEXED_DB_STORE, 'readonly').objectStore(INDEXED_DB_STORE).get(id);
      request.onsuccess = () => {
        try { resolve(readStoredVisualSkin(request.result)); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to read visual skin'));
    });
  }

  async put(value: StoredVisualSkin): Promise<void> {
    readStoredVisualSkin(value);
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).put(value, value.manifest.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to store visual skin'));
    });
  }

  async delete(id: IDBValidKey): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([INDEXED_DB_STORE, INDEXED_DB_SELECTION], 'readwrite');
      transaction.objectStore(INDEXED_DB_STORE).delete(id);
      const selections = transaction.objectStore(INDEXED_DB_SELECTION);
      const selection = selections.get('active');
      selection.onsuccess = () => {
        if (selection.result === id) selections.delete('active');
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Unable to delete visual skin'));
    });
  }

  async getSelection(): Promise<string | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(INDEXED_DB_SELECTION, 'readonly').objectStore(INDEXED_DB_SELECTION).get('active');
      request.onsuccess = () => resolve(typeof request.result === 'string' && request.result.length > 0 ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Unable to read active visual skin'));
    });
  }

  async setSelection(id: string | null): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXED_DB_SELECTION, 'readwrite');
      const store = transaction.objectStore(INDEXED_DB_SELECTION);
      if (id) store.put(id, 'active');
      else store.delete('active');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Unable to store active visual skin'));
    });
  }
}

export function createVisualSkinStorage(): VisualSkinStorage {
  return new IndexedDbVisualSkinStorage();
}

export function toVisualSkinCatalogEntry(value: StoredVisualSkin): VisualSkinCatalogEntry {
  return {
    id: value.manifest.id,
    name: value.manifest.name,
    version: value.manifest.version,
    author: value.manifest.author,
    description: value.manifest.description,
    previewAssetId: value.manifest.previewAssetId,
    previewAsset: value.manifest.previewAssetId
      ? value.assets[value.manifest.previewAssetId]?.dataUrl
      : undefined,
    importedAt: value.importedAt,
  };
}
