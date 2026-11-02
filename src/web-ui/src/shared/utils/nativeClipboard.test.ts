// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: mocks.readText,
  writeText: mocks.writeText,
}));

import {
  hasNativeClipboard,
  readNativeClipboardText,
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
});
