import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import { inheritReviewPermissionMode } from './inheritReviewPermissionMode';

const { getMode, updateMode } = vi.hoisted(() => ({
  getMode: vi.fn(),
  updateMode: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { getSessionPermissionMode: getMode, updateSessionPermissionMode: updateMode },
}));

function session(overrides: Partial<Session>): Session {
  return {
    sessionId: 'child',
    sessionKind: 'review',
    parentSessionId: 'parent',
    workspacePath: '/project',
    config: {},
    ...overrides,
  } as Session;
}

describe('inheritReviewPermissionMode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateMode.mockResolvedValue({ mode: null });
  });

  it.each(['review', 'deep_review'] as const)(
    'inherits auto approval for a %s session through the runtime API',
    async (sessionKind) => {
      getMode.mockResolvedValue({ mode: 'auto_approve' });
      const child = session({ sessionKind, remoteConnectionId: 'ssh-1', remoteSshHost: 'host-1' });
      const parent = session({ sessionId: 'parent', workspacePath: '/project/main',
        remoteConnectionId: 'ssh-1', remoteSshHost: 'host-1' });
      await inheritReviewPermissionMode(child, new Map([['parent', parent]]), vi.fn());
      expect(getMode).toHaveBeenCalledWith({
        sessionId: 'parent', workspacePath: '/project/main',
        remoteConnectionId: 'ssh-1', remoteSshHost: 'host-1',
      });
      expect(updateMode).toHaveBeenCalledWith({
        sessionId: 'child', workspacePath: '/project',
        remoteConnectionId: 'ssh-1', remoteSshHost: 'host-1', mode: 'auto_approve',
      });
    },
  );

  it('refreshes the selection and clears inherited access when the parent resets to default', async () => {
    getMode.mockResolvedValueOnce({ mode: 'full_access' })
      .mockResolvedValueOnce({ mode: 'ask' })
      .mockResolvedValueOnce({ mode: null, turnMode: 'full_access' });
    for (const mode of ['full_access', 'ask', null]) {
      await inheritReviewPermissionMode(session({}), new Map(), vi.fn());
      expect(updateMode).toHaveBeenLastCalledWith(expect.objectContaining({ mode }));
    }
    expect(getMode).toHaveBeenCalledTimes(3);
  });

  it('uses the persisted parent identity when only the review child is open', async () => {
    getMode.mockResolvedValue({ mode: 'auto_approve' });
    await inheritReviewPermissionMode(session({ parentSessionId: undefined,
      btwOrigin: { parentSessionId: 'restored-parent' },
    }), new Map(), vi.fn());
    expect(getMode).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'restored-parent' }));
    expect(updateMode).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto_approve' }));
  });

  it.each(['normal', 'btw', 'subagent', 'miniapp'] as const)('does not change %s permissions', async (sessionKind) => {
    await inheritReviewPermissionMode(session({ sessionKind }), new Map(), vi.fn());
    expect(getMode).not.toHaveBeenCalled();
    expect(updateMode).not.toHaveBeenCalled();
  });

  it('does not retain stale inherited access after a failed parent read', async () => {
    getMode.mockRejectedValue(new Error('parent offline'));
    await expect(inheritReviewPermissionMode(session({}), new Map(), vi.fn())).rejects.toThrow('parent offline');
    expect(updateMode).not.toHaveBeenCalled();
  });

  it('does not write to another surface if the peer changes during the read', async () => {
    getMode.mockResolvedValue({ mode: 'full_access' });
    const assertCurrent = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => {
      throw new Error('surface changed');
    });
    await expect(inheritReviewPermissionMode(session({}), new Map(), assertCurrent)).rejects.toThrow('surface changed');
    expect(updateMode).not.toHaveBeenCalled();
  });
});
