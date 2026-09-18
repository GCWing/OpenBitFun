import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { fileSearchProvider } from './fileSearchProvider';
import type { GlobalSearchRequest } from '../types';

const searchFilenamesMock = vi.hoisted(() => vi.fn());
const searchContentMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: {
    searchFilenamesOnlyDetailed: searchFilenamesMock,
    searchContentOnlyDetailed: searchContentMock,
  },
}));

function workspace(id: string, workspaceKind: WorkspaceKind): WorkspaceInfo {
  return {
    id,
    name: id,
    rootPath: workspaceKind === WorkspaceKind.Remote ? '/srv/private' : 'D:/workspace/local',
    workspaceKind,
    openedAt: '2026-08-16T00:00:00.000Z',
    lastAccessed: '2026-08-16T00:00:00.000Z',
  } as WorkspaceInfo;
}

function request(workspaces: WorkspaceInfo[]): GlobalSearchRequest {
  return {
    rawQuery: 'needle',
    query: 'needle',
    scope: 'content',
    workspaces,
    currentWorkspace: workspaces[0] ?? null,
    limitPerGroup: 20,
    tCommon: (key, options) => `${key}:${String(options?.workspace ?? '')}`,
    tSettings: key => key,
  };
}

describe('fileSearchProvider remote routing', () => {
  beforeEach(() => {
    searchFilenamesMock.mockReset().mockResolvedValue({ results: [], truncated: false });
    searchContentMock.mockReset().mockResolvedValue({ results: [], truncated: false });
  });

  it('only queries IDs whose workspace kind supports content search', async () => {
    const local = workspace('local', WorkspaceKind.Normal);
    const remote = workspace('remote', WorkspaceKind.Remote);

    const result = await fileSearchProvider.search(
      request([local, remote]),
      new AbortController().signal,
    );

    expect(searchFilenamesMock).toHaveBeenCalledTimes(1);
    expect(searchContentMock).toHaveBeenCalledTimes(1);
    expect(searchFilenamesMock).toHaveBeenCalledWith(
      local.id,
      'needle',
      false,
      false,
      false,
      expect.any(AbortSignal),
      20,
      false,
    );
    expect(searchFilenamesMock).not.toHaveBeenCalledWith(
      remote.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'remote_workspace_unsupported' }),
    ]);
  });
});
