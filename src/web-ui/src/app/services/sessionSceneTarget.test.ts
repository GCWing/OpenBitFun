import { describe, expect, it } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import type { WorkspaceInfo } from '@/shared/types';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { resolveSessionSceneTarget } from './sessionSceneTarget';

const session = (overrides: Partial<Session>): Session => ({
  sessionId: 'session', title: 'Session', config: {}, dialogTurns: [],
  status: 'idle', createdAt: 1, lastActiveAt: 1, error: null, ...overrides,
});
const tabId = (value: Session, surfaceId = 'local', workspaces: WorkspaceInfo[] = []) =>
  getSessionSceneTabId(resolveSessionSceneTarget(value, workspaces, surfaceId));

describe('workspace session tab identity', () => {
  it('keeps an execution worktree under its owning project tab', () => {
    expect(tabId(session({ workspacePath: '/project/.worktrees/task', projectWorkspacePath: '/project' })))
      .toBe(tabId(session({ workspacePath: '/project' })));
  });

  it('reads legacy config-only metadata without requiring a workspace id', () => {
    expect(tabId(session({ config: { workspacePath: 'D:\\project\\' } })))
      .toBe(tabId(session({ workspacePath: 'D:/project' })));
  });

  it('scopes identical ids and roots to their device surface', () => {
    const value = session({ workspaceId: 'same', workspacePath: '/project' });
    expect(tabId(value, 'peer-a')).not.toBe(tabId(value, 'peer-b'));
  });

  it('distinguishes workspace IDs even when their paths are identical', () => {
    const remote = session({ workspaceId: 'remote-a', workspacePath: '/Project' });
    expect(tabId(remote)).not.toBe(tabId(session({ ...remote, workspaceId: 'remote-b' })));
    expect(tabId(remote)).not.toBe(tabId(session({ workspaceId: 'local', workspacePath: '/Project' })));
    expect(tabId(remote)).toBe(tabId(session({ ...remote, workspacePath: '/moved' })));
  });

  it('resolves old session metadata to the live workspace id', () => {
    const workspace = { id: 'workspace', rootPath: '/project' } as WorkspaceInfo;
    expect(tabId(session({ workspacePath: '/project' }), 'local', [workspace]))
      .toBe(tabId(session({ workspaceId: 'workspace', workspacePath: '/project' })));
  });

  it('never resolves a remote session to a local directory with the same path', () => {
    const local = { id: 'local-project', rootPath: '/project' } as WorkspaceInfo;
    const remote = session({ workspacePath: '/project', remoteSshHost: 'server' });
    expect(tabId(remote, 'local', [local])).toBe(tabId(remote));
    expect(tabId(remote, 'local', [local])).not.toBe(tabId(session({ workspaceId: local.id })));
  });
});
