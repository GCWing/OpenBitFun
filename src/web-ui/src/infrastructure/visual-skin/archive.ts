import type { FileEntry, ZipReader } from '@zip.js/zip.js';

export const MAX_SKIN_EXPANDED_BYTES = 48 * 1024 * 1024;
export const MAX_SKIN_MANIFEST_BYTES = 512 * 1024;
export const MAX_SKIN_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 96;

/** Metadata preflight and a bounded output sink; no unbounded async() reads. */
export class SkinArchive {
  readonly files = new Map<string, FileEntry>();
  private expandedBytes = 0;
  private constructor(private readonly reader: ZipReader<Uint8Array>) {}

  static async open(source: ArrayBuffer): Promise<SkinArchive> {
    // Skin import is a user action; keep the archive reader out of the startup bundle.
    const zip = await import('@zip.js/zip.js');
    const reader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(source)), {
      useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true,
    });
    const archive = new SkinArchive(reader);
    let entries = 0;
    let declaredBytes = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (++entries > MAX_ENTRIES) throw new Error('Visual skin archive has too many entries');
        const path = entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename;
        if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
          throw new Error(`Visual skin archive path is unsafe: ${entry.filename}`);
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_SKIN_ASSET_BYTES) {
          throw new Error(`Visual skin archive entry exceeds its size limit: ${entry.filename}`);
        }
        declaredBytes += entry.uncompressedSize;
        if (declaredBytes > MAX_SKIN_EXPANDED_BYTES) throw new Error('Visual skin archive exceeds the total expanded size limit');
        if (entry.directory) continue;
        if (entry.encrypted) throw new Error('Encrypted visual skin archives are unsupported');
        if (archive.files.has(entry.filename)) throw new Error(`Duplicate visual skin archive path: ${entry.filename}`);
        archive.files.set(entry.filename, entry);
      }
      if (!archive.files.size) throw new Error('Visual skin archive is empty');
      return archive;
    } catch (error) { await reader.close(); throw error; }
  }

  async read(path: string, limit: number): Promise<Uint8Array> {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`Visual skin archive file is missing: ${path}`);
    if (entry.uncompressedSize > limit) throw new Error(`Visual skin archive entry exceeds its size limit: ${path}`);
    let size = 0;
    const chunks: Uint8Array[] = [];
    const abort = new AbortController();
    try {
      await entry.getData(new WritableStream<Uint8Array>({
        write: chunk => {
          size += chunk.byteLength;
          this.expandedBytes += chunk.byteLength;
          if (size > limit || this.expandedBytes > MAX_SKIN_EXPANDED_BYTES) {
            const error = new Error(`Visual skin decompression size limit exceeded: ${path}`);
            abort.abort(error);
            throw error;
          }
          chunks.push(chunk);
        },
      }), { signal: abort.signal, checkSignature: true, useWebWorkers: false });
      if (size !== entry.uncompressedSize) throw new Error(`Visual skin archive size mismatch: ${path}`);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } catch (error) { abort.abort(error); throw error; }
  }

  async close(): Promise<void> { await this.reader.close(); }
}

export function skinAssetDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
