import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkinArchive, MAX_SKIN_ASSET_BYTES, MAX_SKIN_EXPANDED_BYTES } from './archive';
import { VisualSkinPackageParser } from './parser';

const manifest = { manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'bounded', name: 'Bounded', version: '1' }, modes: { light: {} } };
async function archiveWith(entries: Record<string, Uint8Array | string>) {
  const zip = new JSZip();
  zip.file('skin.json', JSON.stringify(manifest));
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
afterEach(() => vi.restoreAllMocks());

describe('bounded skin archive', () => {
  it('imports a high definition asset above the former 8 MiB limit without changing its bytes', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes[0] = 123; bytes[bytes.length - 1] = 234;
    const archive = await SkinArchive.open(await archiveWith({ 'original.webp': bytes }));
    try {
      const restored = await archive.read('original.webp', MAX_SKIN_ASSET_BYTES);
      expect(restored.byteLength).toBe(bytes.byteLength);
      expect(Buffer.compare(Buffer.from(restored), Buffer.from(bytes))).toBe(0);
    }
    finally { await archive.close(); }
  });
  it('rejects a highly compressed oversized file before any decompression read', async () => {
    const source = await archiveWith({ 'huge.png': new Uint8Array(MAX_SKIN_ASSET_BYTES + 1) });
    expect(source.byteLength).toBeLessThan(32768);
    const read = vi.spyOn(SkinArchive.prototype, 'read');
    await expect(new VisualSkinPackageParser().parse(source)).rejects.toThrow('size limit');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects too many entries, including directories, before decompression', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 97; i++) zip.folder(`folder-${i}`);
    const read = vi.spyOn(SkinArchive.prototype, 'read');
    await expect(new VisualSkinPackageParser().parse(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('too many entries');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects too many ordinary files before decompression', async () => {
    const source = await archiveWith(Object.fromEntries(Array.from({ length: 96 }, (_, i) => [`file-${i}.txt`, 'x'])));
    const read = vi.spyOn(SkinArchive.prototype, 'read');
    await expect(new VisualSkinPackageParser().parse(source)).rejects.toThrow('too many entries');
    expect(read).not.toHaveBeenCalled();
  });

  it('checks the tighter manifest limit before extracting the manifest', async () => {
    const zip = new JSZip();
    zip.file('skin.json', new Uint8Array(512 * 1024 + 1));
    await expect(new VisualSkinPackageParser().parse(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }))).rejects.toThrow('size limit');
  });

  it('rejects the aggregate expanded size before reading any file', async () => {
    const bytes = new Uint8Array(MAX_SKIN_ASSET_BYTES);
    const count = Math.ceil(MAX_SKIN_EXPANDED_BYTES / bytes.length) + 1;
    const source = await archiveWith(Object.fromEntries(Array.from({ length: count }, (_, i) => [`asset-${i}.png`, bytes])));
    expect(source.byteLength).toBeLessThan(100000);
    const read = vi.spyOn(SkinArchive.prototype, 'read');
    await expect(new VisualSkinPackageParser().parse(source)).rejects.toThrow('total expanded size limit');
    expect(read).not.toHaveBeenCalled();
  });

  it('stops the output sink as soon as a stream exceeds its per-file budget', async () => {
    const archive = await SkinArchive.open(await archiveWith({}));
    let writes = 0;
    let aborted = false;
    archive.files.set('stream.bin', {
      uncompressedSize: 1,
      getData: async (output: WritableStream<Uint8Array>, options: { signal: AbortSignal }) => {
        const writer = output.getWriter();
        options.signal.addEventListener('abort', () => { aborted = true; });
        for (let i = 0; i < 1000; i++) { writes++; await writer.write(new Uint8Array(256)); }
      },
    } as unknown as import('@zip.js/zip.js').FileEntry);
    await expect(archive.read('stream.bin', 1024)).rejects.toThrow('decompression size limit');
    expect(writes).toBe(5);
    expect(aborted).toBe(true);
    await archive.close();
  });

  it('enforces the total budget against streamed output as well as directory metadata', async () => {
    const archive = await SkinArchive.open(await archiveWith({}));
    const block = new Uint8Array(MAX_SKIN_ASSET_BYTES);
    let writes = 0;
    archive.files.set('stream.bin', {
      uncompressedSize: block.length,
      getData: async (output: WritableStream<Uint8Array>) => {
        const writer = output.getWriter(); writes++; await writer.write(block); await writer.close();
      },
    } as unknown as import('@zip.js/zip.js').FileEntry);
    for (let i = 0; i < MAX_SKIN_EXPANDED_BYTES / block.length; i++) await archive.read('stream.bin', block.length);
    await expect(archive.read('stream.bin', block.length)).rejects.toThrow('decompression size limit');
    expect(writes).toBe(MAX_SKIN_EXPANDED_BYTES / block.length + 1);
    await archive.close();
  });

  it('rejects a real compressed stream whose directory understates its output size', async () => {
    const source = await archiveWith({ 'forged.png': new Uint8Array(2 * 1024 * 1024) });
    const bytes = new Uint8Array(source);
    const view = new DataView(source);
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength));
      if (name === 'forged.png') view.setUint32(i + 24, 1024, true);
    }
    const archive = await SkinArchive.open(source);
    await expect(archive.read('forged.png', MAX_SKIN_ASSET_BYTES)).rejects.toThrow(/size/i);
    await archive.close();
  });

  it('retains CRC validation and imports a normal multi-file package', async () => {
    const zip = new JSZip();
    zip.file('skin.json', JSON.stringify({ ...manifest, assets: { image: { mimeType: 'image/png', source: { kind: 'path', path: 'image.png' } } } }));
    zip.file('image.png', new Uint8Array([1, 2, 3]));
    const source = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
    expect((await new VisualSkinPackageParser().parse(source)).assets.image.dataUrl).toBe('data:image/png;base64,AQID');
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 1 && bytes[i + 1] === 2 && bytes[i + 2] === 3) { bytes[i] = 4; break; }
    }
    await expect(new VisualSkinPackageParser().parse(source)).rejects.toThrow(/signature/i);
  });
});
