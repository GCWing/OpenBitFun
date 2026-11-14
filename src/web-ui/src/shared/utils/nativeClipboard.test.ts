// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  constructAdapter: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: mocks.readText,
  writeText: mocks.writeText,
}));

vi.mock('@/infrastructure/api/adapters/tauri-adapter', () => ({
  TauriTransportAdapter: class {
    constructor() {
      mocks.constructAdapter();
    }
    request = mocks.request;
  },
}));

import {
  hasNativeClipboard,
  readNativeClipboardText,
  WRITE_CLIPBOARD_IMAGE_COMMAND,
  writeNativeClipboardImage,
  writeNativeClipboardText,
} from './nativeClipboard';

function markTauriHost(): void {
  (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};
}

function clearTauriHost(): void {
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
}

beforeEach(() => {
  mocks.readText.mockReset();
  mocks.writeText.mockReset();
  mocks.request.mockReset();
  clearTauriHost();
});

afterEach(() => {
  clearTauriHost();
});

describe('native clipboard bridge', () => {
  it('stays out of the way outside the desktop host', async () => {
    expect(hasNativeClipboard()).toBe(false);
    await expect(readNativeClipboardText()).resolves.toBeNull();
    await expect(writeNativeClipboardText('text')).resolves.toBe(false);
    expect(mocks.readText).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('reads and writes through the desktop host', async () => {
    markTauriHost();
    mocks.readText.mockResolvedValue('from the system clipboard');
    mocks.writeText.mockResolvedValue(undefined);

    expect(hasNativeClipboard()).toBe(true);
    await expect(readNativeClipboardText()).resolves.toBe('from the system clipboard');
    await expect(writeNativeClipboardText('composed text')).resolves.toBe(true);
    expect(mocks.writeText).toHaveBeenCalledWith('composed text');
  });

  it('reports failure so the caller can fall back to the Web API', async () => {
    markTauriHost();
    mocks.readText.mockRejectedValue(new Error('clipboard unavailable'));
    mocks.writeText.mockRejectedValue(new Error('clipboard unavailable'));

    await expect(readNativeClipboardText()).resolves.toBeNull();
    await expect(writeNativeClipboardText('text')).resolves.toBe(false);
  });

  it('sends image writes to the local desktop host as raw PNG bytes', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const png = new Blob([pngBytes], { type: 'image/png' });

    await expect(writeNativeClipboardImage(png)).resolves.toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();

    markTauriHost();
    mocks.request.mockResolvedValue(undefined);
    await expect(writeNativeClipboardImage(png)).resolves.toBe(true);

    // The controller's own Tauri host, never the rendered Peer device.
    expect(mocks.constructAdapter).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const [command, body] = mocks.request.mock.calls[0];
    expect(command).toBe(WRITE_CLIPBOARD_IMAGE_COMMAND);
    // A typed array is the raw IPC body; an object or number array would be JSON.
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual(Array.from(pngBytes));

    mocks.request.mockRejectedValue(new Error('clipboard unavailable'));
    await expect(writeNativeClipboardImage(png)).resolves.toBe(false);
  });
});
