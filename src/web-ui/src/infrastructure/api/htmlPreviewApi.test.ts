import { describe, expect, it, vi } from 'vitest';
import { htmlPreviewApi } from './htmlPreviewApi';
const invoke = vi.hoisted(() => vi.fn(async () => ({ sessionId: 'preview-1', url: 'http://localhost/preview' })));
vi.mock('./service-api/ApiClient', () => ({ api: { invoke } }));
describe('HTML preview workspace identity', () => {
  it('sends the saved workspace ID alongside the file IO operand', async () => {
    const request = { workspaceId: 'remote-id', filePath: '/repo/index.html', peerDeviceMode: false };
    await htmlPreviewApi.create(request);
    expect(invoke).toHaveBeenCalledWith('html_preview_create', { request });
  });
  it('rejects a missing ID before invoking the host', async () => {
    invoke.mockClear();
    await expect(htmlPreviewApi.create({ workspaceId: '', filePath: '/repo/index.html', peerDeviceMode: false })).rejects.toThrow('workspace ID');
    expect(invoke).not.toHaveBeenCalled();
  });
});
