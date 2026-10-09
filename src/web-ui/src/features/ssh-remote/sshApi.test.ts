import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { invoke },
}));

import { sshApi } from './sshApi';

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

  it('does not start a transfer stopped before the backend registration', async () => {
    await expect(sshApi.uploadFromLocalPath(
      'connection-1', '/local/b.bin', '/remote/b.bin', undefined, 'stopped', () => true,
    )).rejects.toThrow('Transfer cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });
});
