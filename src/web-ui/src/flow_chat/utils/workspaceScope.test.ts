import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';
import { findWorkspaceForSession } from './workspaceScope';

function remoteWorkspace(id: string, connectionId: string): WorkspaceInfo {
  return {
    id,
    rootPath: '/workspace',
    workspaceKind: 'remote',
    connectionId,
    sshHost: `${connectionId}.example.test`,
  } as WorkspaceInfo;
}

describe('findWorkspaceForSession', () => {
  it('does not retarget a stale workspace ID to the same path', () => {
    const workspace = { id: 'new-id', rootPath: '/project' } as WorkspaceInfo;
    expect(findWorkspaceForSession({ workspaceId: 'old-id', workspacePath: '/project' },
      new Map([[workspace.id, workspace]]).values())).toBeUndefined();
  });
  it('uses remote identity instead of an ambiguous POSIX path', () => {
    const first = remoteWorkspace('workspace-a', 'connection-a');
    const second = remoteWorkspace('workspace-b', 'connection-b');

    expect(findWorkspaceForSession({
      workspacePath: '/workspace',
      remoteConnectionId: 'connection-b',
    }, [first, second])).toBe(second);
  });
});
