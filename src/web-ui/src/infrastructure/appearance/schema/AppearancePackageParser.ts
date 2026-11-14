import type { AppearanceRegistry } from '../registry/AppearanceRegistry';
import { assertValidAppearancePackage } from './AppearancePackageValidator';
import type {
  AppearancePackageAsset,
  StoredAppearanceAsset,
  StoredAppearancePackage,
} from '../types';
import { APPEARANCE_SCHEMA_VERSION } from '../types';

const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 50_000_000;
const MAX_VIDEO_DIMENSION = 4_096;
const MAX_VIDEO_PIXELS = 9_000_000;
const MAX_VIDEO_DURATION_SECONDS = 60;
const MANIFEST_PATH = 'appearance.json';
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

interface ImageInfo {
  mimeType: Extract<AppearancePackageAsset, { kind: 'image' }>['mimeType'];
  width: number;
  height: number;
}

export interface AppearanceVideoMetadata {
  width: number;
  height: number;
  durationSeconds: number;
}

export type AppearanceVideoMetadataReader = (
  bytes: Uint8Array,
  mimeType: Extract<AppearancePackageAsset, { kind: 'video' }>['mimeType'],
) => Promise<AppearanceVideoMetadata>;

export async function readAppearanceVideoMetadata(
  bytes: Uint8Array,
  mimeType: Extract<AppearancePackageAsset, { kind: 'video' }>['mimeType'],
): Promise<AppearanceVideoMetadata> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  try {
    return await new Promise<AppearanceVideoMetadata>((resolve, reject) => {
      let timeout = 0;
      const finish = (callback: () => void): void => {
        window.clearTimeout(timeout);
        video.onloadedmetadata = null;
        video.onerror = null;
        callback();
      };
      timeout = window.setTimeout(
        () => finish(() => reject(new Error('Appearance video metadata timed out'))),
        10_000,
      );
      video.onloadedmetadata = () => finish(() => resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        durationSeconds: video.duration,
      }));
      video.onerror = () => finish(() => reject(new Error('Appearance video format or codec is unsupported')));
      video.src = url;
      video.load();
    });
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export class AppearancePackageParser {
  constructor(
    private readonly registry: AppearanceRegistry,
    private readonly videoMetadataReader: AppearanceVideoMetadataReader = readAppearanceVideoMetadata,
  ) {}

  async parse(source: ArrayBuffer): Promise<StoredAppearancePackage> {
    if (source.byteLength === 0 || source.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Appearance archive must be between 1 byte and ${MAX_ARCHIVE_BYTES} bytes`);
    }
    this.assertSafeZipMetadata(source);
    // Package import is a user action; keep the archive reader out of the startup bundle.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(source, { checkCRC32: true });
    const files = Object.values(zip.files).filter(file => !file.dir);
    if (files.length === 0 || files.length > MAX_ENTRIES) {
      throw new Error(`Appearance archive must contain between 1 and ${MAX_ENTRIES} files`);
    }
    files.forEach(file => {
      const metadata = file as { unsafeOriginalName?: string; unixPermissions?: number | string };
      this.assertSafeArchivePath(file.name, metadata.unsafeOriginalName);
      const permissions = typeof metadata.unixPermissions === 'string'
        ? parseInt(metadata.unixPermissions, 8)
        : metadata.unixPermissions;
      if (typeof permissions === 'number' && (permissions & 0o170000) === 0o120000) {
        throw new Error(`Symbolic links are not allowed in appearance archives: ${file.name}`);
      }
    });

    const manifestFile = zip.file(MANIFEST_PATH);
    if (!manifestFile) throw new Error(`Appearance archive must contain ${MANIFEST_PATH}`);
    const manifestBytes = await manifestFile.async('uint8array');
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Appearance manifest is too large');

    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch (error) {
      throw new Error(`Appearance manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = assertValidAppearancePackage(rawManifest, this.registry);
    const declaredPaths = new Map<string, { id: string; definition: AppearancePackageAsset }>();
    Object.entries(manifest.assets ?? {}).forEach(([id, definition]) => {
      const path = definition.source.path;
      if (declaredPaths.has(path)) throw new Error(`Appearance assets cannot share package path: ${path}`);
      declaredPaths.set(path, { id, definition });
    });

    const allowedPaths = new Set([MANIFEST_PATH, ...declaredPaths.keys()]);
    files.forEach(file => {
      if (!allowedPaths.has(file.name)) throw new Error(`Undeclared archive file: ${file.name}`);
    });
    declaredPaths.forEach((_, path) => {
      if (!zip.file(path)) throw new Error(`Declared appearance asset is missing: ${path}`);
    });

    const assets: Record<string, StoredAppearanceAsset> = {};
    let expandedBytes = manifestBytes.byteLength;
    const previewAssetId = manifest.preview?.assetId;
    for (const [path, { id, definition }] of declaredPaths) {
      const bytes = await zip.file(path)!.async('uint8array');
      expandedBytes += bytes.byteLength;
      const maxAssetBytes = definition.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (bytes.byteLength === 0 || bytes.byteLength > maxAssetBytes) {
        throw new Error(`Appearance asset has invalid size: ${path}`);
      }
      if (id === previewAssetId && bytes.byteLength > MAX_PREVIEW_BYTES) {
        throw new Error(`Appearance preview asset exceeds the allowed size: ${path}`);
      }
      if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Appearance archive expands beyond the allowed size');
      const metadata = definition.kind === 'image'
        ? this.validateImage(path, bytes, definition.mimeType)
        : await this.validateVideo(path, bytes, definition.mimeType);
      const expectedDigest = manifest.integrity?.sha256[id];
      if (expectedDigest) {
        const actualDigest = await this.sha256(bytes);
        if (actualDigest !== expectedDigest.toLowerCase()) throw new Error(`Appearance asset integrity mismatch: ${path}`);
      }
      assets[id] = {
        mimeType: definition.mimeType,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ...metadata,
      };
    }

    const canonicalManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    if (new TextEncoder().encode(canonicalManifest).byteLength > MAX_MANIFEST_BYTES) {
      throw new Error('Canonical Appearance manifest is too large');
    }
    zip.file(MANIFEST_PATH, canonicalManifest);
    const canonicalArchive = await zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    if (canonicalArchive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error('Canonical Appearance archive is too large');
    }

    return {
      manifest,
      archive: canonicalArchive,
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets,
      importedAt: new Date().toISOString(),
    };
  }

  private assertSafeZipMetadata(source: ArrayBuffer): void {
    const view = new DataView(source);
    const minimumOffset = Math.max(0, source.byteLength - 65_557);
    let endOffset = -1;
    for (let offset = source.byteLength - 22; offset >= minimumOffset; offset -= 1) {
      if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error('Appearance archive central directory is missing');
    const diskNumber = view.getUint16(endOffset + 4, true);
    const centralDisk = view.getUint16(endOffset + 6, true);
    const entryCount = view.getUint16(endOffset + 10, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    if (diskNumber !== 0 || centralDisk !== 0 || entryCount === 0xffff
      || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('Multi-disk and ZIP64 appearance archives are not supported');
    }
    if (centralOffset + centralSize > endOffset) throw new Error('Appearance archive central directory is invalid');

    let offset = centralOffset;
    let fileCount = 0;
    let expandedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > source.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
        throw new Error('Appearance archive central directory entry is invalid');
      }
      const flags = view.getUint16(offset + 8, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const entryLength = 46 + fileNameLength + extraLength + commentLength;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new Error('ZIP64 appearance entries are not supported');
      }
      if ((flags & 0x0001) !== 0) throw new Error('Encrypted appearance archive entries are not supported');
      if (offset + entryLength > source.byteLength) throw new Error('Appearance archive central directory entry is truncated');
      const nameBytes = new Uint8Array(source, offset + 46, fileNameLength);
      const name = new TextDecoder((flags & 0x0800) !== 0 ? 'utf-8' : 'windows-1252').decode(nameBytes);
      if (!name.endsWith('/')) {
        fileCount += 1;
        expandedBytes += uncompressedSize;
        if (uncompressedSize > MAX_VIDEO_BYTES) throw new Error(`Appearance archive entry is too large: ${name}`);
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Appearance archive expands beyond the allowed size');
      }
      offset += entryLength;
    }
    if (fileCount === 0 || fileCount > MAX_ENTRIES) {
      throw new Error(`Appearance archive must contain between 1 and ${MAX_ENTRIES} files`);
    }
  }

  private validateImage(
    path: string,
    bytes: Uint8Array,
    expectedMimeType: Extract<AppearancePackageAsset, { kind: 'image' }>['mimeType'],
  ): Pick<StoredAppearanceAsset, 'width' | 'height'> {
    const image = this.readImageInfo(bytes);
    if (image.mimeType !== expectedMimeType) throw new Error(`Appearance asset MIME mismatch: ${path}`);
    if (image.width <= 0 || image.height <= 0
      || image.width > MAX_DIMENSION || image.height > MAX_DIMENSION
      || image.width * image.height > MAX_PIXELS) {
      throw new Error(`Appearance image dimensions exceed the allowed limit: ${path}`);
    }
    return { width: image.width, height: image.height };
  }

  private async validateVideo(
    path: string,
    bytes: Uint8Array,
    expectedMimeType: Extract<AppearancePackageAsset, { kind: 'video' }>['mimeType'],
  ): Promise<Pick<StoredAppearanceAsset, 'width' | 'height' | 'durationSeconds'>> {
    const actualMimeType = this.readVideoMimeType(bytes);
    if (actualMimeType !== expectedMimeType) throw new Error(`Appearance asset MIME mismatch: ${path}`);
    const metadata = await this.videoMetadataReader(bytes, expectedMimeType);
    if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0
      || metadata.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
      throw new Error(`Appearance video duration exceeds the allowed limit: ${path}`);
    }
    if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)
      || metadata.width <= 0 || metadata.height <= 0
      || metadata.width > MAX_VIDEO_DIMENSION || metadata.height > MAX_VIDEO_DIMENSION
      || metadata.width * metadata.height > MAX_VIDEO_PIXELS) {
      throw new Error(`Appearance video dimensions exceed the allowed limit: ${path}`);
    }
    return {
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
    };
  }

  private assertSafeArchivePath(path: string, unsafeOriginalName?: string): void {
    if (unsafeOriginalName && unsafeOriginalName !== path) throw new Error(`Unsafe archive path: ${unsafeOriginalName}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(path) || path.includes('..') || path.includes('\\') || path.startsWith('/')) {
      throw new Error(`Unsafe archive path: ${path}`);
    }
  }

  private readImageInfo(bytes: Uint8Array): ImageInfo {
    if (bytes.length >= 24 && this.ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) {
      return { mimeType: 'image/png', width: this.u32be(bytes, 16), height: this.u32be(bytes, 20) };
    }
    if (bytes.length >= 10 && (this.ascii(bytes, 0, 6) === 'GIF87a' || this.ascii(bytes, 0, 6) === 'GIF89a')) {
      return { mimeType: 'image/gif', width: this.u16le(bytes, 6), height: this.u16le(bytes, 8) };
    }
    if (bytes.length >= 12 && this.ascii(bytes, 0, 4) === 'RIFF' && this.ascii(bytes, 8, 4) === 'WEBP') {
      return this.readWebpInfo(bytes);
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return this.readJpegInfo(bytes);
    }
    throw new Error('Appearance asset is not a supported image');
  }

  private readVideoMimeType(bytes: Uint8Array): 'video/mp4' | 'video/webm' {
    if (bytes.length >= 12 && this.ascii(bytes, 4, 4) === 'ftyp') return 'video/mp4';
    if (bytes.length >= 16
      && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
      && this.containsAscii(bytes, 'webm', 4_096)) {
      return 'video/webm';
    }
    throw new Error('Appearance asset is not a supported video');
  }

  private containsAscii(bytes: Uint8Array, expected: string, maxBytes: number): boolean {
    const limit = Math.min(bytes.length, maxBytes) - expected.length;
    for (let offset = 0; offset <= limit; offset += 1) {
      if (this.ascii(bytes, offset, expected.length).toLowerCase() === expected) return true;
    }
    return false;
  }

  private readJpegInfo(bytes: Uint8Array): ImageInfo {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = this.u16be(bytes, offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mimeType: 'image/jpeg', width: this.u16be(bytes, offset + 7), height: this.u16be(bytes, offset + 5) };
      }
      offset += 2 + length;
    }
    throw new Error('Appearance JPEG dimensions could not be read');
  }

  private readWebpInfo(bytes: Uint8Array): ImageInfo {
    const chunk = this.ascii(bytes, 12, 4);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        mimeType: 'image/webp',
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { mimeType: 'image/webp', width: this.u16le(bytes, 26) & 0x3fff, height: this.u16le(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    throw new Error('Appearance WebP dimensions could not be read');
  }

  private async sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  private ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.slice(offset, offset + length));
  }

  private u16be(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  private u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  private u32be(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }
}
