// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureElementToDownloadsPng } from './captureElementToDownloadsPng';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  write: vi.fn(),
  success: vi.fn(),
  downloads: vi.fn(async () => '/downloads'),
}));
vi.mock('./exportImageCapture', () => ({ captureExportCanvas: mocks.capture }));
vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: mocks.downloads,
  join: async (directory: string, name: string) => `${directory}/${name}`,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.write }));
vi.mock('@openbitfun/ui', () => ({ Button: () => null }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { success: mocks.success } }));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key, formatDate: () => 'export-date' },
}));
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: {} }));
vi.mock('@/infrastructure/appearance/builtins/catalog', () => ({ getBuiltinAppearanceThemeToken: () => 'white' }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capture.mockReset();
  mocks.write.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

function encodedCanvas(blob: Blob | null) {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  vi.spyOn(canvas, 'toBlob').mockImplementation(callback => callback(blob));
  mocks.capture.mockResolvedValue(canvas);
  return canvas;
}

describe('widget image download', () => {
  it('writes the verified raster and reports success after saving', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const canvas = encodedCanvas({ arrayBuffer: async () => bytes.buffer } as Blob);
    const element = document.createElement('div');
    await captureElementToDownloadsPng(element, 'Widget');
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(element, 'white');
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('/downloads/Widget_export-date.png', bytes);
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });

  it('propagates blank capture failure without creating a download or success notification', async () => {
    mocks.capture.mockRejectedValue(new Error('Capture returned a blank image'));
    await expect(captureElementToDownloadsPng(document.createElement('div'), 'Widget'))
      .rejects.toThrow('blank image');
    expect(mocks.downloads).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it.each(['null', 'throw'])('releases the raster and does not save after %s encoding failure', async failure => {
    const canvas = encodedCanvas(null);
    if (failure === 'throw') vi.mocked(canvas.toBlob).mockImplementation(() => { throw new Error('Encoding failed'); });
    await expect(captureElementToDownloadsPng(document.createElement('div'), 'Widget')).rejects.toThrow();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(mocks.downloads).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('does not report success when saving fails', async () => {
    encodedCanvas({ arrayBuffer: async () => new ArrayBuffer(1) } as Blob);
    mocks.write.mockRejectedValue(new Error('Disk full'));
    await expect(captureElementToDownloadsPng(document.createElement('div'), 'Widget'))
      .rejects.toThrow('Disk full');
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
