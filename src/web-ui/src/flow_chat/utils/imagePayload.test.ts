import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageContext } from '@/shared/types/context';
import { buildImagePayload } from './imagePayload';

const mocks = vi.hoisted(() => ({
  surfaceId: 'local',
  advertised: false,
  invoke: vi.fn(),
  assertCurrent: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => ({ surfaceId: mocks.surfaceId, assertCurrent: mocks.assertCurrent }),
  isLocalSurface: (id: string) => id === 'local',
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => ({ getState: () => ({ capabilities: { inlineImageAttachmentsV1: mocks.advertised } }) }) },
}));
const clipboard: ImageContext = {
  id: 'clipboard-1', type: 'image', timestamp: 1, imagePath: '/controller/stale.png',
  imageName: 'screen.png', fileSize: 3, mimeType: 'image/png', source: 'clipboard',
  isLocal: false, dataUrl: 'data:image/png;base64,YQ==',
};
const dropped: ImageContext = {
  ...clipboard, id: 'dropped-1', isLocal: true, dataUrl: undefined,
  imagePath: '/remote/workspace/chart.png', imageName: 'chart.png',
};

beforeEach(() => {
  mocks.surfaceId = 'local';
  mocks.advertised = false;
  mocks.invoke.mockReset();
  mocks.assertCurrent.mockReset();
});

describe('image payload host ownership', () => {
  it.each(['local', 'peer-cli'])('retains pixels for the receiving %s Runtime without a controller path', async surface => {
    mocks.surfaceId = surface;
    mocks.advertised = surface !== 'local';
    const result = await buildImagePayload([clipboard]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(result?.imageContexts[0].data_url).toBe(clipboard.dataUrl);
    expect(result?.imageContexts[0].image_path).toBeUndefined();
    expect(result?.imageDisplayData[0].dataUrl).toBe(clipboard.dataUrl);
  });

  it('preserves the old host upload path when the new capability was not advertised', async () => {
    mocks.surfaceId = 'old-peer';
    mocks.invoke.mockResolvedValue([{ id: clipboard.id, image_path: '/peer/upload.png' }]);
    const result = await buildImagePayload([clipboard]);
    expect(mocks.invoke).toHaveBeenCalledWith('upload_image_contexts', expect.any(Object));
    expect(result?.imageContexts[0].image_path).toBe('/peer/upload.png');
    expect(result?.imageContexts[0].data_url).toBe(clipboard.dataUrl);
    expect(mocks.assertCurrent).toHaveBeenCalled();
  });

  it('does not submit across a surface switch or hide a rejected legacy upload', async () => {
    mocks.surfaceId = 'old-peer';
    mocks.invoke.mockRejectedValueOnce(new Error('unavailable'));
    await expect(buildImagePayload([clipboard])).rejects.toThrow('unavailable');
    mocks.invoke.mockResolvedValue([{ id: clipboard.id, image_path: '/peer/upload.png' }]);
    mocks.assertCurrent.mockImplementation(() => { throw new Error('surface changed'); });
    await expect(buildImagePayload([clipboard])).rejects.toThrow('surface changed');
  });

  it('inlines pixels for a dropped local file so path-blind clients can draw it', async () => {
    mocks.invoke.mockResolvedValue('YQ==');
    const result = await buildImagePayload([dropped]);
    expect(mocks.invoke).toHaveBeenCalledWith('read_file_content', {
      request: { filePath: dropped.imagePath, encoding: 'base64', remoteConnectionId: undefined },
    });
    expect(result?.imageContexts[0].image_path).toBe(dropped.imagePath);
    expect(result?.imageContexts[0].data_url).toBe('data:image/png;base64,YQ==');
    expect(result?.imageDisplayData[0].dataUrl).toBe('data:image/png;base64,YQ==');
    expect(mocks.assertCurrent).toHaveBeenCalled();
  });

  it('keeps the attachment on an unreadable path instead of failing the send', async () => {
    mocks.invoke.mockRejectedValue(new Error('gone'));
    const result = await buildImagePayload([dropped]);
    expect(result?.imageContexts[0].image_path).toBe(dropped.imagePath);
    expect(result?.imageContexts[0].data_url).toBeUndefined();
  });

  it('leaves oversized local images as a path so turn storage stays bounded', async () => {
    const result = await buildImagePayload([{ ...dropped, fileSize: 9 * 1024 * 1024 }]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(result?.imageContexts[0].image_path).toBe(dropped.imagePath);
    expect(result?.imageContexts[0].data_url).toBeUndefined();
  });
});
