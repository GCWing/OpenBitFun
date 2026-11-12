// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { invoke },
}));

import { sshApi } from './sshApi';
import { SSH_OPERATION_TIMEOUT_EVENT } from './sshOperationEvents';

describe('sshApi request deadlines', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('lets a file transfer run past the default request deadline', async () => {
    await sshApi.downloadToLocalPath('connection-1', '/remote/a.bin', '/local/a.bin', undefined, 'download-1');
    expect(invoke).toHaveBeenCalledWith(
      'remote_download_to_local_path',
      expect.objectContaining({ transferId: expect.any(String) }),
      { timeout: 0 },
    );

    await sshApi.uploadFromLocalPath('connection-1', '/local/b.bin', '/remote/b.bin', undefined, 'upload-1');
    expect(invoke).toHaveBeenLastCalledWith(
      'remote_upload_from_local_path',
      expect.objectContaining({ transferId: expect.any(String) }),
      { timeout: 0 },
    );
  });

  it('keeps the default deadline for commands with no stop action', async () => {
    await sshApi.readFile('connection-1', '/remote/a.txt');
    // No third argument: the shared client keeps its own deadline, which is
    // what ends a command whose host never answers.
    expect(invoke).toHaveBeenCalledWith('remote_read_file', {
      connectionId: 'connection-1',
      path: '/remote/a.txt',
    });

    await sshApi.downloadToLocalPath('connection-1', '/remote/a.bin', '/local/a.bin');
    expect(invoke).toHaveBeenLastCalledWith(
      'remote_download_to_local_path',
      expect.objectContaining({ transferId: expect.any(String) }),
      undefined,
    );

    await sshApi.uploadFromLocalPath('connection-1', '/local/b.bin', '/remote/b.bin');
    expect(invoke).toHaveBeenLastCalledWith(
      'remote_upload_from_local_path',
      expect.objectContaining({ transferId: expect.any(String) }),
      undefined,
    );
  });

  it('announces a timed-out connection operation so the link is re-verified', async () => {
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ connectionId: string }>).detail.connectionId);
    };
    window.addEventListener(SSH_OPERATION_TIMEOUT_EVENT, listener);
    try {
      invoke.mockRejectedValueOnce(new Error('Request timeout'));
      await expect(sshApi.readDir('connection-1', '/remote')).rejects.toThrow('Request timeout');
      invoke.mockRejectedValueOnce(new Error('permission denied'));
      await expect(sshApi.readFile('connection-2', '/remote/a.txt')).rejects.toThrow('permission denied');
      invoke.mockRejectedValueOnce('Command timed out');
      await expect(sshApi.execute('connection-3', 'true')).rejects.toBe('Command timed out');
    } finally {
      window.removeEventListener(SSH_OPERATION_TIMEOUT_EVENT, listener);
    }
    expect(seen).toEqual(['connection-1', 'connection-3']);
  });

  it('does not start a transfer stopped before the backend registration', async () => {
    await expect(sshApi.uploadFromLocalPath(
      'connection-1', '/local/b.bin', '/remote/b.bin', undefined, 'stopped', () => true,
    )).rejects.toThrow('Transfer cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });
});
