// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasNativeClipboard: vi.fn(),
  writeNativeClipboardImage: vi.fn(),
}));

vi.mock('./nativeClipboard', () => ({
  hasNativeClipboard: mocks.hasNativeClipboard,
  writeNativeClipboardImage: mocks.writeNativeClipboardImage,
}));

import {
  canCopyImageSource,
  copyImageToClipboard,
  CrossOriginImageError,
  isCrossOriginImageSource,
} from './imageClipboard';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const ENCODED_PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9])], { type: 'image/png' });

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob> | Blob>) {}
}

class FakeImage {
  static created: FakeImage[] = [];
  crossOrigin: string | null = null;
  decoding = '';
  src = '';
  naturalWidth = 3;
  naturalHeight = 2;
  constructor() {
    FakeImage.created.push(this);
  }
  decode(): Promise<void> {
    return Promise.resolve();
  }
}

let clipboardWrite: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let getContext: ReturnType<typeof vi.spyOn>;
let drawImage: ReturnType<typeof vi.fn>;

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

/** The PNG that was handed to the Web Clipboard API. */
async function webClipboardPng(): Promise<Blob> {
  const [[items]] = clipboardWrite.mock.calls as [[FakeClipboardItem[]]];
  expect(items).toHaveLength(1);
  return await items[0].items['image/png'];
}

beforeEach(() => {
  FakeImage.created = [];
  mocks.hasNativeClipboard.mockReset().mockReturnValue(false);
  mocks.writeNativeClipboardImage.mockReset().mockResolvedValue(true);
  clipboardWrite = vi.fn().mockImplementation(async (items: FakeClipboardItem[]) => {
    await Promise.all(Object.values(items[0].items));
  });
  fetchMock = vi.fn(async (source: string) => ({
    blob: async () => (source.startsWith('data:image/png')
      ? new Blob([PNG_BYTES], { type: 'image/png' })
      : new Blob([JPEG_BYTES], { type: 'image/jpeg' })),
  }));
  drawImage = vi.fn();
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: clipboardWrite },
  });
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(callback => callback(ENCODED_PNG));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('image clipboard source policy', () => {
  it('offers copying only for images the page can read back', () => {
    const origin = window.location.origin;

    expect(isCrossOriginImageSource('https://images.example.com/cat.png')).toBe(true);
    expect(isCrossOriginImageSource('http://images.example.com/cat.png')).toBe(true);
    // A shared string prefix is not the same origin (another port here).
    expect(isCrossOriginImageSource(`${origin}1/cat.png`)).toBe(true);

    expect(isCrossOriginImageSource(`${origin}/cat.png`)).toBe(false);
    expect(isCrossOriginImageSource('/workspace/cat.png')).toBe(false);
    expect(isCrossOriginImageSource('data:image/png;base64,AAAA')).toBe(false);
    expect(isCrossOriginImageSource('blob:http://localhost/1234')).toBe(false);
    expect(isCrossOriginImageSource('asset://localhost/Users/me/cat.png')).toBe(false);
    expect(isCrossOriginImageSource('http://asset.localhost/C%3A%5Ccat.png')).toBe(false);

    expect(canCopyImageSource('data:image/png;base64,AAAA')).toBe(true);
    expect(canCopyImageSource('https://images.example.com/cat.png')).toBe(false);
    expect(canCopyImageSource('')).toBe(false);
    expect(canCopyImageSource(null)).toBe(false);
    expect(canCopyImageSource(undefined)).toBe(false);
  });

  it('refuses a cross-origin image with a specific error before touching any clipboard', async () => {
    await expect(copyImageToClipboard('https://images.example.com/cat.png'))
      .rejects.toBeInstanceOf(CrossOriginImageError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeImage.created).toHaveLength(0);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(mocks.writeNativeClipboardImage).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard', () => {
  it('passes an inline PNG to the clipboard without decoding it', async () => {
    await copyImageToClipboard('data:image/png;base64,iVBORw0KGgo=');

    const png = await webClipboardPng();
    expect(png.type).toBe('image/png');
    expect(await bytesOf(png)).toEqual(Array.from(PNG_BYTES));
    expect(FakeImage.created).toHaveLength(0);
    expect(getContext).not.toHaveBeenCalled();
  });

  it('recognizes a PNG blob URL by its signature even without a MIME type', async () => {
    fetchMock.mockResolvedValueOnce({ blob: async () => new Blob([PNG_BYTES]) });

    await copyImageToClipboard('blob:http://localhost/5f0c');

    const png = await webClipboardPng();
    expect(png.type).toBe('image/png');
    expect(await bytesOf(png)).toEqual(Array.from(PNG_BYTES));
    expect(getContext).not.toHaveBeenCalled();
  });

  it('re-encodes other formats through a canvas', async () => {
    await copyImageToClipboard('data:image/jpeg;base64,/9j/4AAQ');

    expect(FakeImage.created).toHaveLength(1);
    expect(FakeImage.created[0].crossOrigin).toBeNull();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(await webClipboardPng()).toBe(ENCODED_PNG);
  });

  it('reads Tauri asset images with a CORS request so the canvas stays readable', async () => {
    await copyImageToClipboard('http://asset.localhost/C%3A%5Ccat.webp');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeImage.created[0].crossOrigin).toBe('anonymous');
    expect(await webClipboardPng()).toBe(ENCODED_PNG);
  });

  it('falls back to the desktop host with the same PNG when the WebView refuses', async () => {
    clipboardWrite.mockRejectedValue(new DOMException('Document is not focused', 'NotAllowedError'));
    mocks.hasNativeClipboard.mockReturnValue(true);

    await copyImageToClipboard('data:image/png;base64,iVBORw0KGgo=');

    expect(mocks.writeNativeClipboardImage).toHaveBeenCalledTimes(1);
    const [png] = mocks.writeNativeClipboardImage.mock.calls[0] as [Blob];
    expect(await bytesOf(png)).toEqual(Array.from(PNG_BYTES));
    expect(getContext).not.toHaveBeenCalled();
  });

  it('rejects when neither clipboard accepts the image', async () => {
    const refusal = new DOMException('Document is not focused', 'NotAllowedError');
    clipboardWrite.mockRejectedValue(refusal);

    await expect(copyImageToClipboard('data:image/png;base64,iVBORw0KGgo=')).rejects.toBe(refusal);
    expect(mocks.writeNativeClipboardImage).not.toHaveBeenCalled();

    mocks.hasNativeClipboard.mockReturnValue(true);
    mocks.writeNativeClipboardImage.mockResolvedValue(false);
    await expect(copyImageToClipboard('data:image/png;base64,iVBORw0KGgo='))
      .rejects.toThrow('No clipboard accepted the image');
  });
});
