import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  hostInvoke: vi.fn(),
  controllerRequest: vi.fn(),
  advertised: false,
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.hostInvoke } }));
vi.mock('@/infrastructure/api/adapters', () => ({
  createTransportAdapter: () => ({ request: mocks.controllerRequest }),
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  isLocalSurface: (id: string) => id === 'local',
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: {
    get: () => ({ getState: () => ({ capabilities: { runtimeAttachmentUploadV1: mocks.advertised } }) }),
  },
}));

import {
  buildRuntimeAttachmentUri,
  canUploadControllerFiles,
  getControllerFileMetadata,
  uploadControllerFileToRuntime,
} from './controllerFileTransfer';

const scope = (surfaceId: string, current = () => true): SurfaceScope => ({
  surfaceId,
  epoch: 1,
  signal: new AbortController().signal,
  isCurrent: current,
  assertCurrent: () => {
    if (!current()) throw new Error('surface changed');
  },
  key: (...parts) => JSON.stringify([surfaceId, ...parts]),
});

/** Host stub that follows the `workspace_file_upload` cursor contract. */
function installUploadHost() {
  let next = 0;
  let total = 0;
  const appended: Uint8Array[] = [];
  mocks.hostInvoke.mockImplementation(async (_command: string, args: { request: Record<string, unknown> }) => {
    const request = args.request;
    const status = () => ({ transferId: request.transferId, nextOffset: next, totalBytes: total, completed: next === total && request.action === 'finish' });
    switch (request.action) {
      case 'begin':
        total = request.totalBytes as number;
        return status();
      case 'append': {
        const bytes = Uint8Array.from(atob(request.contentBase64 as string), ch => ch.charCodeAt(0));
        appended.push(bytes);
        next += bytes.length;
        return status();
      }
      case 'finish':
        return status();
      default:
        return status();
    }
  });
  return appended;
}

beforeEach(() => {
  mocks.hostInvoke.mockReset();
  mocks.controllerRequest.mockReset();
  mocks.advertised = false;
});

describe('controller file transfer', () => {
  it('reads controller metadata through the controller host with the local-provider marker', async () => {
    mocks.controllerRequest.mockResolvedValue({ path: '/Users/me/a.txt', size: 5, isFile: true, isDir: false });
    const metadata = await getControllerFileMetadata('/Users/me/a.txt');
    expect(mocks.controllerRequest).toHaveBeenCalledWith('get_file_metadata', {
      request: { path: '/Users/me/a.txt', remoteConnectionId: '' },
    });
    expect(mocks.hostInvoke).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({ size: 5, isFile: true, isDir: false });
  });

  it('gates uploads on the local build or the negotiated peer capability', () => {
    expect(canUploadControllerFiles(scope('local'))).toBe(true);
    expect(canUploadControllerFiles(scope('peer-1'))).toBe(false);
    mocks.advertised = true;
    expect(canUploadControllerFiles(scope('peer-1'))).toBe(true);
  });

  it('stages bytes read on the controller into the runtime attachments directory', async () => {
    mocks.controllerRequest.mockResolvedValue(btoa('hello'));
    const appended = installUploadHost();

    const hostPath = await uploadControllerFileToRuntime({
      path: 'C:\\Users\\me\\notes:v1.md',
      name: 'notes:v1.md',
      workspaceId: 'ws-1',
      scope: scope('peer-1'),
      isCurrent: () => true,
    });

    expect(mocks.controllerRequest).toHaveBeenCalledWith('read_file_content', {
      request: { filePath: 'C:\\Users\\me\\notes:v1.md', encoding: 'base64', remoteConnectionId: '' },
    });
    expect(hostPath).toMatch(/^openbitfun:\/\/runtime\/ws-1\/attachments\/[0-9a-f]{16}\/notes_v1\.md$/);
    const actions = mocks.hostInvoke.mock.calls.map(([command, args]) => [command, args.request.action]);
    expect(actions).toEqual([
      ['workspace_file_upload', 'begin'],
      ['workspace_file_upload', 'append'],
      ['workspace_file_upload', 'finish'],
    ]);
    const begin = mocks.hostInvoke.mock.calls[0][1].request;
    expect(begin).toMatchObject({
      path: hostPath,
      workspaceId: 'ws-1',
      totalBytes: 5,
      expectedHash: '',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(begin.transferId).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(appended[0])).toBe('hello');
  });

  it('stops before sending bytes once the rendered surface changed', async () => {
    mocks.controllerRequest.mockResolvedValue(btoa('hello'));
    installUploadHost();
    let current = true;
    mocks.hostInvoke.mockImplementationOnce(async (_command: string, args: { request: Record<string, unknown> }) => {
      current = false;
      return { transferId: args.request.transferId, nextOffset: 0, totalBytes: 5, completed: false };
    });

    await expect(uploadControllerFileToRuntime({
      path: '/tmp/a.txt',
      name: 'a.txt',
      workspaceId: 'ws-1',
      scope: scope('peer-1', () => current),
      isCurrent: () => true,
    })).rejects.toThrow('surface changed');
    const actions = mocks.hostInvoke.mock.calls.map(([, args]) => args.request.action);
    expect(actions).not.toContain('append');
  });

  it('builds the runtime URI the agent tools resolve', () => {
    expect(buildRuntimeAttachmentUri('ws-9', 'abc', 'a b.txt'))
      .toBe('openbitfun://runtime/ws-9/attachments/abc/a b.txt');
  });
});
