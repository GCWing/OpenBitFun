// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { VisualSkinImageResources } from './asset-resources';
import { partAssetDeclarations } from './part-paint';
import type { StoredVisualSkin } from './types';

function skin(id: string, size = 32): StoredVisualSkin {
  const dataUrl = 'data:image/png;base64,' + Buffer.alloc(size, 17).toString('base64');
  return { manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id, name: id, version: '1' }, modes: { light: {} }, importedAt: '',
    assets: { image: { id: 'image', mimeType: 'image/png', source: { kind: 'data', data: dataUrl }, dataUrl } },
    components: [{ component: 'menu', slots: { root: { assetId: 'image' } } }],
  };
}
afterEach(() => vi.restoreAllMocks());

it('keeps multi-megabyte materials out of CSS variables while retaining exact bytes', async () => {
  const value = skin('large', 2 * 1024 * 1024), resources = new VisualSkinImageResources();
  try {
    const urls = resources.ensure(value), url = urls.get('image')!;
    expect(url.startsWith('blob:')).toBe(true);
    expect(resources.ensure(value)).toBe(urls);
    const response = await fetch(url);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(2 * 1024 * 1024); expect(bytes[0]).toBe(17); expect(bytes.at(-1)).toBe(17);
    const dom = new JSDOM('<html></html>');
    vi.stubGlobal('document', dom.window.document);
    try { expect(partAssetDeclarations(value, urls).length).toBeLessThan(160); }
    finally { vi.unstubAllGlobals(); dom.window.close(); }
  } finally { resources.retain([]); }
});

it('retains active/preview images and revokes discarded generations', async () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL'), resources = new VisualSkinImageResources();
  const a = skin('a'), b = skin('b');
  const urlA = resources.ensure(a).get('image')!, urlB = resources.ensure(b).get('image')!;
  resources.retain([a,b]); expect(revoke).not.toHaveBeenCalled();
  resources.retain([a]); expect(revoke).toHaveBeenCalledWith(urlB); expect(revoke).not.toHaveBeenCalledWith(urlA);
  expect((await fetch(urlA)).ok).toBe(true);
  resources.retain([]); expect(revoke).toHaveBeenCalledWith(urlA);
});

it('releases a partial allocation without discarding the previous display generation', () => {
  const resources = new VisualSkinImageResources(), a = skin('a'), b = skin('b');
  const previous = resources.ensure(a).get('image')!;
  b.assets.second = { ...b.assets.image, id: 'second' };
  b.components![0].slots!.second = { assetId: 'second' };
  const create = URL.createObjectURL.bind(URL), revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(create).mockImplementationOnce(() => { throw new Error('Allocation failed'); });
  expect(() => resources.ensure(b)).toThrow('Allocation failed');
  expect(revoke).toHaveBeenCalledTimes(1); expect(revoke).not.toHaveBeenCalledWith(previous);
  expect(resources.ensure(a).get('image')).toBe(previous);
  resources.retain([]);
});
