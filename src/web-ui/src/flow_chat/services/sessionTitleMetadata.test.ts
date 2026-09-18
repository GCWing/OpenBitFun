import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import {
  activateSurface,
  getActiveSurfaceScope,
  resetDeviceSurfaceForTest,
  SurfaceChangedError,
} from '@/infrastructure/peer-device/deviceSurface';
import type { SessionMetadata } from '@/shared/types/session-history';
import { createDefaultSessionTitleDescriptor } from '../utils/sessionTitle';
import { initializeSessionTitleMetadata } from './sessionTitleMetadata';

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: { loadSessionMetadata: vi.fn(), saveSessionMetadata: vi.fn() },
}));

const descriptor = createDefaultSessionTitleDescriptor(() => 'New Session');
const metadata: SessionMetadata = {
  sessionId: 'created', sessionName: descriptor.text, workspacePath: 'workspace-remote',
  agentType: 'Standard', modelName: 'model', createdAt: 1, lastActiveAt: 1,
  turnCount: 0, messageCount: 0, toolCallCount: 0, status: 'active', tags: [], todos: [],
  customMetadata: { runtimeOwned: 'preserved' },
};

describe('initializeSessionTitleMetadata', () => {
  beforeEach(() => {
    resetDeviceSurfaceForTest();
    vi.resetAllMocks();
    vi.mocked(sessionAPI.loadSessionMetadata).mockResolvedValueOnce(metadata).mockResolvedValue({
      ...metadata, customMetadata: { ...metadata.customMetadata, workspaceSessionNumber: 2 },
    });
    vi.mocked(sessionAPI.saveSessionMetadata).mockResolvedValue(undefined);
  });

  it('uses the host number and updates only the title metadata through the owning remote workspace', async () => {
    const title = await initializeSessionTitleMetadata(
      'created', descriptor, 'workspace-remote', getActiveSurfaceScope(),
    );
    expect(title).toEqual({ ...descriptor, workspaceSessionNumber: 2 });
    expect(sessionAPI.loadSessionMetadata).toHaveBeenCalledTimes(2);
    expect(sessionAPI.loadSessionMetadata).toHaveBeenNthCalledWith(1, 'created', 'workspace-remote');
    expect(sessionAPI.loadSessionMetadata).toHaveBeenNthCalledWith(2, 'created', 'workspace-remote');
    expect(sessionAPI.saveSessionMetadata).toHaveBeenCalledExactlyOnceWith({
      ...metadata,
      customMetadata: {
        ...metadata.customMetadata,
        titleSource: descriptor.source, titleKey: descriptor.key, titleParams: descriptor.params,
      },
    }, 'workspace-remote', ['titleMetadata']);
  });

  it('keeps an unnumbered host response as ordinary text without migration', async () => {
    vi.mocked(sessionAPI.loadSessionMetadata).mockResolvedValue({ ...metadata, customMetadata: {} });
    expect(await initializeSessionTitleMetadata('created', descriptor, 'workspace-remote', getActiveSurfaceScope()))
      .toEqual({ source: 'text', text: 'New Session' });
    expect(sessionAPI.saveSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it.each(['read', 'write', 'read-after-save'])('preserves the created session when optional title metadata %s fails', async (stage) => {
    if (stage === 'read') vi.mocked(sessionAPI.loadSessionMetadata).mockReset().mockRejectedValue(new Error('offline'));
    else if (stage === 'read-after-save') vi.mocked(sessionAPI.loadSessionMetadata).mockReset().mockResolvedValueOnce(metadata).mockRejectedValue(new Error('offline'));
    else vi.mocked(sessionAPI.saveSessionMetadata).mockRejectedValue(new Error('offline'));
    expect(await initializeSessionTitleMetadata('created', descriptor, 'workspace-remote', getActiveSurfaceScope()))
      .toEqual({ source: 'text', text: 'New Session' });
    expect(sessionAPI.loadSessionMetadata).toHaveBeenCalledTimes(stage === 'read-after-save' ? 2 : 1);
    expect(sessionAPI.saveSessionMetadata).toHaveBeenCalledTimes(stage === 'read' ? 0 : 1);
  });

  it('does not write to another surface after the metadata read', async () => {
    vi.mocked(sessionAPI.loadSessionMetadata).mockReset().mockImplementation(async () => {
      activateSurface('local');
      return metadata;
    });
    await expect(initializeSessionTitleMetadata('created', descriptor, 'workspace-remote', getActiveSurfaceScope()))
      .rejects.toBeInstanceOf(SurfaceChangedError);
    expect(sessionAPI.saveSessionMetadata).not.toHaveBeenCalled();
  });

  it('rejects a stale surface even when the old host returns a read error', async () => {
    vi.mocked(sessionAPI.loadSessionMetadata).mockReset().mockImplementation(async () => {
      activateSurface('local');
      throw new Error('offline');
    });
    await expect(initializeSessionTitleMetadata('created', descriptor, 'workspace-remote', getActiveSurfaceScope()))
      .rejects.toBeInstanceOf(SurfaceChangedError);
    expect(sessionAPI.saveSessionMetadata).not.toHaveBeenCalled();
  });
});
