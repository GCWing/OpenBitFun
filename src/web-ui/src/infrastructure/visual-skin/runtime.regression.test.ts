// @vitest-environment jsdom
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualSkinRuntime } from './runtime';
import { VisualSkinPackageParser } from './parser';
import type { VisualSkinStorage } from './storage';
import type { StoredVisualSkin, VisualSkinPackage } from './types';

class TestStorage implements VisualSkinStorage {
  values = new Map<string, StoredVisualSkin>();
  selection: string | null = null;
  failSelection = false;
  failDeletion = false;
  selectionWrites = 0;
  async list() { return { skins: [...this.values.values()], invalidRecords: [] }; }
  async get(id: string) { return this.values.get(id) ?? null; }
  async put(skin: StoredVisualSkin) { this.values.set(skin.manifest.id, skin); }
  async delete(id: IDBValidKey) {
    if (this.failDeletion) throw new Error('Deletion transaction failed');
    this.values.delete(String(id));
    if (this.selection === id) this.selection = null;
  }
  async getSelection() { return this.selection; }
  async setSelection(id: string | null) {
    this.selectionWrites++;
    if (this.failSelection) throw new Error('Selection write failed');
    this.selection = id;
  }
}
const parser = new VisualSkinPackageParser();
function source(id: string): VisualSkinPackage {
  return { manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id, name: id, version: '1' }, modes: { light: { tokens: { 'color.content.primary': id === 'a' ? '#111111' : '#222222' } } } };
}
async function install(storage: TestStorage, value: VisualSkinPackage) {
  await storage.put(await parser.parse(new TextEncoder().encode(JSON.stringify(value)).buffer));
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const runtimes: VisualSkinRuntime[] = [];
function createRuntime(storage: TestStorage) { const runtime = new VisualSkinRuntime(storage); runtimes.push(runtime); runtime.watchProjection(); return runtime; }
function entry(runtime: VisualSkinRuntime, path: string) { return runtime.getSnapshot().projection?.entries.find(item => item.path === path); }
function paintPosition(id: string) { return getComputedStyle(document.getElementById(id)!).backgroundPosition; }

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-openbitfun-skin-id');
  document.documentElement.removeAttribute('data-color-scheme');
  document.documentElement.removeAttribute('data-contrast');
  document.querySelectorAll('style[data-openbitfun-skin-runtime]').forEach(node => node.remove());
});
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.dispose()); });

describe('skin activation failure', () => {
  it.each(['empty', 'active', 'preview', 'previewOnly'] as const)('keeps the previous display and selection after a failed write: %s', async kind => {
    const storage = new TestStorage();
    for (const id of ['a', 'b', 'c']) await install(storage, source(id));
    const runtime = createRuntime(storage);
    await runtime.initialize();
    if (kind === 'active' || kind === 'preview') await runtime.activate('a');
    if (kind === 'preview' || kind === 'previewOnly') await runtime.preview('b');
    const before = runtime.getSnapshot();
    const css = document.querySelector('style[data-openbitfun-skin-runtime]')?.textContent;
    const domId = document.documentElement.getAttribute('data-openbitfun-skin-id');
    const persisted = storage.selection;
    storage.failSelection = true;
    await expect(runtime.activate('c')).rejects.toThrow('Selection write failed');
    expect(runtime.getSnapshot()).toMatchObject({ activeSkinId: before.activeSkinId, activeSkin: before.activeSkin, previewSkinId: before.previewSkinId, status: before.status, error: 'Selection write failed' });
    expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe(domId);
    expect(document.querySelector('style[data-openbitfun-skin-runtime]')?.textContent).toBe(css);
    expect(storage.selection).toBe(persisted);
    if (kind !== 'empty') expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe(kind === 'active' ? '#111111' : '#222222');
  });
});

describe('skin deletion', () => {
  it('restores A after removing preview B even when selection writes fail', async () => {
    const storage = new TestStorage();
    for (const id of ['a', 'b']) await install(storage, source(id));
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    await runtime.preview('b');
    const writes = storage.selectionWrites;
    storage.failSelection = true;
    await runtime.remove('b');
    expect(storage.selectionWrites).toBe(writes);
    expect(storage.selection).toBe('a');
    expect([...storage.values.keys()]).toEqual(['a']);
    expect(runtime.getSnapshot()).toMatchObject({ activeSkinId: 'a', previewSkinId: null, status: 'ready' });
    expect(runtime.getSnapshot().catalog.map(item => item.id)).toEqual(['a']);
    expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe('a');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#111111');
  });

  it.each(['active', 'preview'] as const)('preserves display, snapshot, catalog and data when deleting %s aborts', async kind => {
    const storage = new TestStorage();
    for (const id of ['a', 'b']) await install(storage, source(id));
    const runtime = createRuntime(storage);
    await runtime.initialize();
    await runtime.activate('a');
    if (kind === 'preview') await runtime.preview('b');
    const before = runtime.getSnapshot();
    const css = document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent;
    const domId = document.documentElement.getAttribute('data-openbitfun-skin-id');
    const writes = storage.selectionWrites;
    storage.failDeletion = true;
    await expect(runtime.remove(kind === 'preview' ? 'b' : 'a')).rejects.toThrow('Deletion transaction failed');
    expect(runtime.getSnapshot()).toEqual({ ...before, error: 'Deletion transaction failed' });
    expect(storage.selection).toBe('a');
    expect([...storage.values.keys()]).toEqual(['a', 'b']);
    expect(storage.selectionWrites).toBe(writes);
    expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe(domId);
    expect(document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent).toBe(css);
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe(kind === 'preview' ? '#222222' : '#111111');
  });

  it('clears a deleted active skin and its persisted selection without a separate write', async () => {
    const storage = new TestStorage();
    await install(storage, source('a'));
    const runtime = createRuntime(storage);
    await runtime.initialize();
    await runtime.activate('a');
    const writes = storage.selectionWrites;
    storage.failSelection = true;
    await runtime.remove('a');
    expect(storage.selectionWrites).toBe(writes);
    expect(storage.selection).toBeNull();
    expect(storage.values.size).toBe(0);
    expect(runtime.getSnapshot()).toMatchObject({ activeSkinId: null, activeSkin: null, previewSkinId: null, catalog: [], projection: null, status: 'ready' });
    expect(document.documentElement.hasAttribute('data-openbitfun-skin-id')).toBe(false);
    expect(document.querySelector('style[data-openbitfun-skin-runtime]')).toBeNull();
  });

  it('cancels preview without rewriting the persisted selection', async () => {
    const storage = new TestStorage();
    for (const id of ['a', 'b']) await install(storage, source(id));
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    await runtime.preview('b');
    const writes = storage.selectionWrites;
    storage.failSelection = true;
    await runtime.cancelPreview();
    expect(storage.selectionWrites).toBe(writes);
    expect(storage.selection).toBe('a');
    expect(runtime.getSnapshot()).toMatchObject({ activeSkinId: 'a', previewSkinId: null, status: 'ready' });
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#111111');
  });
});

describe('rejected imports', () => {
  it('does not persist an oversized archive or change the current skin', async () => {
    const storage = new TestStorage();
    await install(storage, source('a'));
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    const snapshot = runtime.getSnapshot();
    const css = document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent;
    const zip = new JSZip();
    zip.file('skin.json', JSON.stringify(source('rejected')));
    zip.file('huge.png', new Uint8Array(16 * 1024 * 1024 + 1));
    await expect(runtime.importPackage(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }))).rejects.toThrow('size limit');
    expect([...storage.values.keys()]).toEqual(['a']);
    expect(storage.selection).toBe('a');
    expect(runtime.getSnapshot()).toEqual(snapshot);
    expect(document.documentElement.getAttribute('data-openbitfun-skin-id')).toBe('a');
    expect(document.querySelector('style[data-openbitfun-skin-runtime]')!.textContent).toBe(css);
  });
});

describe('owned component parts', () => {
  it('styles root and descendant parts, follows owner state, and isolates nested instances', async () => {
    const storage = new TestStorage();
    const skin = source('a');
    skin.assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } };
    skin.components = [{ component: 'button', slots: { root: { assetId: 'art', backgroundPosition: '10% 10%' }, 'leading-icon': { assetId: 'art', backgroundPosition: '20% 20%' } }, states: { selected: { slots: { 'leading-icon': { assetId: 'art', backgroundPosition: '60% 60%' } } } } }];
    await install(storage, skin);
    document.body.innerHTML = '<div id="outer" data-openbitfun-component="button" data-openbitfun-part="root"><span id="outer-icon" data-openbitfun-part="leading-icon"></span><div id="inner" data-openbitfun-component="button" data-openbitfun-part="root"><span id="inner-icon" data-openbitfun-part="leading-icon"></span></div><div data-openbitfun-component="other"><span id="foreign-icon" data-openbitfun-part="leading-icon"></span></div></div>';
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    expect(paintPosition('outer')).toBe('10% 10%');
    expect(paintPosition('outer-icon')).toBe('20% 20%');
    expect(paintPosition('inner-icon')).toBe('20% 20%');
    expect(paintPosition('foreign-icon')).not.toBe('20% 20%');
    expect(entry(runtime, 'components[0].slots.leading-icon')?.status).toBe('projected');
    document.getElementById('outer')!.setAttribute('aria-selected', 'true');
    await tick();
    expect(paintPosition('outer-icon')).toBe('60% 60%');
    expect(paintPosition('inner-icon')).toBe('20% 20%');
    expect(entry(runtime, 'components[0].states.selected.slots.leading-icon')?.status).toBe('projected');
    document.getElementById('outer')!.removeAttribute('aria-selected');
    await tick();
    expect(paintPosition('outer-icon')).toBe('20% 20%');
    expect(entry(runtime, 'components[0].states.selected.slots.leading-icon')?.status).toBe('unresolved');
    document.body.innerHTML = '';
    await tick();
    expect(entry(runtime, 'components[0].slots.leading-icon')?.status).toBe('unresolved');
    document.body.innerHTML = '<div data-openbitfun-component="button"><span id="new-icon" data-openbitfun-part="leading-icon"></span></div>';
    await tick();
    expect(paintPosition('new-icon')).toBe('20% 20%');
    expect(entry(runtime, 'components[0].slots.leading-icon')?.status).toBe('projected');
  });

  it('updates focus state diagnostics and styles from native focus events', async () => {
    const storage = new TestStorage();
    const skin = source('a');
    skin.assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } };
    skin.components = [{ component: 'field', states: { focus: { slots: { root: { assetId: 'art', backgroundPosition: '50% 50%' } } } } }];
    await install(storage, skin);
    document.body.innerHTML = '<input id="focus" data-openbitfun-component="field" data-openbitfun-part="root">';
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    expect(entry(runtime, 'components[0].states.focus')?.status).toBe('unresolved');
    (document.getElementById('focus') as HTMLInputElement).focus();
    await tick();
    expect(entry(runtime, 'components[0].states.focus')?.status).toBe('projected');
    expect(paintPosition('focus')).toBe('50% 50%');
    (document.getElementById('focus') as HTMLInputElement).blur();
    await tick();
    expect(entry(runtime, 'components[0].states.focus')?.status).toBe('unresolved');
  });

  it('refreshes native input state after property changes without attribute mutations', async () => {
    const storage = new TestStorage();
    const skin = source('a');
    skin.assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } };
    skin.components = [{ component: 'check', states: { checked: { slots: { root: { assetId: 'art', backgroundPosition: '40% 40%' } } } } }];
    await install(storage, skin);
    document.body.innerHTML = '<input id="check" type="checkbox" data-openbitfun-component="check" data-openbitfun-part="root">';
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    const checkbox = document.getElementById('check') as HTMLInputElement;
    expect(entry(runtime, 'components[0].states.checked.slots.root')?.status).toBe('unresolved');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(paintPosition('check')).toBe('40% 40%');
    expect(entry(runtime, 'components[0].states.checked.slots.root')?.status).toBe('projected');
  });
});

it('retains displayed image URLs through failed activation/deletion and releases cancelled previews', async () => {
  const storage = new TestStorage();
  for (const id of ['a','b']) {
    const skin = source(id);
    skin.assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } };
    skin.components = [{ component: 'button', slots: { root: { assetId: 'art' } } }];
    await install(storage, skin);
  }
  const runtime = createRuntime(storage), revoke = vi.spyOn(URL, 'revokeObjectURL');
  const url = () => getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-skin-asset-0').match(/blob:[^"')]+/)![0];
  try {
    await runtime.activate('a'); const a = url();
    await runtime.preview('b'); const b = url();
    storage.failSelection = true; await expect(runtime.activate('b')).rejects.toThrow();
    expect(url()).toBe(b); expect(revoke).not.toHaveBeenCalledWith(a); expect(revoke).not.toHaveBeenCalledWith(b);
    storage.failSelection = false; await runtime.cancelPreview();
    expect(url()).toBe(a); expect(revoke).toHaveBeenCalledWith(b);
    storage.failDeletion = true; await expect(runtime.remove('a')).rejects.toThrow();
    expect(url()).toBe(a); expect(revoke).not.toHaveBeenCalledWith(a);
    storage.failDeletion = false; await runtime.remove('a');
    expect(revoke).toHaveBeenCalledWith(a); expect(runtime.getSnapshot().activeSkinId).toBeNull();
  } finally { revoke.mockRestore(); }
});

it('removes owned paint before releasing image URLs on disposal without changing the saved selection', async () => {
  const storage = new TestStorage(), skin = source('a');
  skin.assets = { art: { mimeType: 'image/svg+xml', source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' } } };
  skin.components = [{ component: 'button', slots: { root: { assetId: 'art' } } }];
  await install(storage, skin);
  document.body.innerHTML = '<button data-openbitfun-component="button">Test</button>';
  const runtime = createRuntime(storage);
  await runtime.activate('a');
  const url = getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-skin-asset-0').match(/blob:[^"')]+/)![0];
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
    expect(document.querySelector('style[data-openbitfun-skin-runtime]')).toBeNull();
    expect(document.documentElement.hasAttribute('data-openbitfun-skin-id')).toBe(false);
    expect(document.querySelector('[data-openbitfun-skin-node]')).toBeNull();
  });
  try {
    runtime.dispose();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(storage.selection).toBe('a');
    expect(storage.values.has('a')).toBe(true);
  } finally { revoke.mockRestore(); }
});

describe('interaction refresh work', () => {
  it('computes interaction diagnostics only for a visible watcher and releases the subscription', async () => {
    const storage = new TestStorage(), skin = source('a');
    skin.components = [{ component: 'button', states: { selected: { tokens: { 'color.content.primary': '#333333' } } } }];
    await install(storage, skin);
    document.body.innerHTML = '<button data-openbitfun-component="button">A</button>';
    const runtime = new VisualSkinRuntime(storage); runtimes.push(runtime);
    await runtime.activate('a'); await tick();
    const button = document.querySelector('button')!, query = vi.spyOn(document, 'querySelectorAll');
    let visible = false;
    const stop = runtime.watchProjection(() => visible);
    try {
      button.setAttribute('aria-selected', 'true');
      button.dispatchEvent(new Event('pointerover', { bubbles: true })); await tick();
      expect(query).not.toHaveBeenCalled();
      visible = true;
      button.dispatchEvent(new Event('pointerover', { bubbles: true })); await tick();
      expect(entry(runtime, 'components[0].states.selected')?.status).toBe('projected');
      query.mockClear(); stop();
      button.setAttribute('aria-selected', 'false');
      button.dispatchEvent(new Event('pointerout', { bubbles: true })); await tick();
      expect(query).not.toHaveBeenCalled();
    } finally { stop(); query.mockRestore(); }
  });

  it('keeps native state paint and diagnostics current without rewriting surface markers', async () => {
    const storage = new TestStorage(), skin = source('a');
    skin.surfaces = [{ surface: 'navigation' }];
    skin.components = [{ component: 'button', states: { selected: { slots: { root: { foregroundToken: 'color.content.primary' } } } } }];
    await install(storage, skin);
    document.body.innerHTML = '<nav data-openbitfun-surface="navigation"></nav><button data-openbitfun-component="button">A</button>';
    const runtime = createRuntime(storage); await runtime.activate('a'); await tick();
    const nav = document.querySelector('nav')!, button = document.querySelector('button')!;
    const markerWrites: MutationRecord[] = [];
    const observer = new MutationObserver(records => markerWrites.push(...records));
    observer.observe(nav, { attributes: true });
    const divs = vi.spyOn(document, 'createElement');
    try {
      button.setAttribute('aria-selected', 'true');
      button.dispatchEvent(new Event('pointerover', { bubbles: true }));
      await tick();
      expect(entry(runtime, 'components[0].states.selected.slots.root')?.status).toBe('projected');
      expect(getComputedStyle(button).color).toBe('var(--openbitfun-color-content-primary)');
      expect(divs.mock.calls.filter(([tag]) => tag === 'div')).toHaveLength(0);
      expect(markerWrites).toHaveLength(0);
      button.removeAttribute('aria-selected'); await tick();
      expect(entry(runtime, 'components[0].states.selected.slots.root')?.status).toBe('unresolved');
    } finally { observer.disconnect(); divs.mockRestore(); }
  });

  it('ignores text streaming and unrelated class/style animation while still compiling newly mounted parts', async () => {
    const storage = new TestStorage(), skin = source('a');
    skin.components = [{ component: 'button', slots: { root: { foregroundToken: 'color.content.primary' } } }];
    await install(storage, skin);
    document.body.innerHTML = '<section id="stream"></section>';
    const runtime = createRuntime(storage); await runtime.activate('a'); await tick();
    const stream = document.getElementById('stream')!, query = vi.spyOn(document, 'querySelectorAll');
    try {
      stream.className = 'animated'; stream.style.opacity = '.8'; stream.textContent = 'Streaming text';
      await tick();
      expect(query).not.toHaveBeenCalled();
      stream.innerHTML = '<button data-openbitfun-component="button">New target</button>';
      await tick();
      expect(entry(runtime, 'components[0].slots.root')?.status).toBe('projected');
      expect(getComputedStyle(stream.firstElementChild!).color).toBe('var(--openbitfun-color-content-primary)');
      stream.firstElementChild!.remove(); await tick();
      expect(entry(runtime, 'components[0].slots.root')?.status).toBe('unresolved');
    } finally { query.mockRestore(); }
  });
});

describe('current mode diagnostics', () => {
  it('tracks light/dark, high-contrast overrides and superseded declarations', async () => {
    const storage = new TestStorage();
    const skin = source('a');
    skin.modes = {
      light: { tokens: { 'color.content.primary': '#111111', 'color.content.secondary': '#333333' } },
      dark: { tokens: { 'color.content.primary': '#eeeeee' } },
      highContrastLight: { tokens: { 'color.content.primary': '#000000' } },
    };
    await install(storage, skin);
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    const path = (mode: string) => `modes.${mode}.tokens.color.content.primary`;
    expect(entry(runtime, path('light'))?.status).toBe('projected');
    expect(entry(runtime, path('dark'))?.status).toBe('inactive');
    expect(entry(runtime, path('highContrastLight'))?.status).toBe('inactive');
    document.documentElement.setAttribute('data-contrast', 'high');
    await tick();
    expect(runtime.getSnapshot().projection).toMatchObject({ mode: 'highContrastLight', baseMode: 'light', projected: 2 });
    expect(entry(runtime, path('light'))?.status).toBe('inactive');
    expect(entry(runtime, path('highContrastLight'))?.status).toBe('projected');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#000000');
    document.documentElement.setAttribute('data-color-scheme', 'dark');
    document.documentElement.removeAttribute('data-contrast');
    await tick();
    expect(runtime.getSnapshot().projection).toMatchObject({ mode: 'dark', baseMode: 'dark', projected: 1 });
    expect(entry(runtime, path('dark'))?.status).toBe('projected');
    expect(entry(runtime, path('light'))?.status).toBe('inactive');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#eeeeee');
  });

  it('reports the actual source when a single-mode skin falls back', async () => {
    const storage = new TestStorage();
    await install(storage, source('a'));
    document.documentElement.setAttribute('data-color-scheme', 'dark');
    const runtime = createRuntime(storage);
    await runtime.activate('a');
    expect(runtime.getSnapshot().projection).toMatchObject({ mode: 'dark', baseMode: 'light', projected: 1, inactive: 0 });
    expect(entry(runtime, 'modes.light.tokens.color.content.primary')?.status).toBe('projected');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-color-content-primary')).toBe('#111111');
  });
});
