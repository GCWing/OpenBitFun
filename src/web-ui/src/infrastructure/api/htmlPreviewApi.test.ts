import { beforeEach, describe, expect, it, vi } from 'vitest';
import { htmlPreviewApi } from './htmlPreviewApi';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./service-api/ApiClient', () => ({ api: { invoke } }));
const request = { workspaceId: 'remote-id', filePath: '/repo/dist/index.html' };
const result = { sessionId: 'preview-1', url: 'http://127.0.0.1:1234/preview' };

beforeEach(() => {
  activateSurface('local');
  invoke.mockReset().mockResolvedValue(result);
});

describe('HTML preview workspace and device identity', () => {
  it('keeps local and SSH previews on the controller using the saved workspace ID', async () => {
    await htmlPreviewApi.create(request);
    expect(invoke).toHaveBeenCalledWith('html_preview_create', { request: { ...request, peerDeviceMode: false } });
  });

  it('binds peer resources to the selected device without copying paths into local IO', async () => {
    activateSurface('linux-cli');
    await htmlPreviewApi.create(request);
    expect(invoke).toHaveBeenCalledWith('html_preview_create', { request: { ...request, peerDeviceMode: true, peerDeviceId: 'linux-cli' } });
  });

  it('releases a late gateway when device activation changes, including A to B to A', async () => {
    activateSurface('peer-a');
    let resolve!: (value: typeof result) => void;
    invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = htmlPreviewApi.create(request);
    activateSurface('peer-b');
    activateSurface('peer-a');
    resolve(result);
    await expect(pending).rejects.toMatchObject({ isSurfaceChangedError: true });
    expect(invoke).toHaveBeenLastCalledWith('html_preview_release', { request: { sessionId: result.sessionId } });
  });

  it('rejects a missing ID before invoking the host', async () => {
    await expect(htmlPreviewApi.create({ ...request, workspaceId: '' })).rejects.toThrow('workspace ID');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves an explicit old-peer or offline failure without a local retry', async () => {
    activateSurface('old-peer');
    invoke.mockRejectedValueOnce(new Error('Update OpenBitFun on the controlled device'));
    await expect(htmlPreviewApi.create(request)).rejects.toThrow('Update OpenBitFun');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
