import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSessionTreeBranch } from './deleteSessionTreeBranch';

const mocks = vi.hoisted(() => ({
  lineage: vi.fn(), deleteSession: vi.fn(), discard: vi.fn(), assertCurrent: vi.fn(),
  clearIntent: vi.fn(), clearTransition: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { getSessionLineage: mocks.lineage } }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { deleteSession: mocks.deleteSession } }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => ({ assertCurrent: mocks.assertCurrent }) }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: new Map() }) } }));
vi.mock('./FlowChatManager', () => ({ FlowChatManager: { getInstance: () => ({ discardLocalSession: mocks.discard }) } }));
vi.mock('./sessionOpenIntent', () => ({ clearRecentHistorySessionOpenIntent: mocks.clearIntent, clearHistorySessionOpenTransition: mocks.clearTransition }));

const location = { sessionId: 'child', workspaceId: 'workspace-remote' };
describe('deleteSessionTreeBranch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.lineage.mockResolvedValue({ rootSessionId: 'root', sessions: [
      { sessionId: 'root', sessionName: 'Root', createdAtMs: 1 },
      { sessionId: 'child', parentSessionId: 'root', sessionName: 'Child', createdAtMs: 2 },
      { sessionId: 'grandchild', parentSessionId: 'child', sessionName: 'Done', status: 'completed', createdAtMs: 3 },
      { sessionId: 'sibling', parentSessionId: 'root', sessionName: 'Sibling', createdAtMs: 4 },
    ] });
  });

  it('deletes unloaded, inactive descendants before their parent and preserves the remote location', async () => {
    await deleteSessionTreeBranch(location);
    expect(mocks.lineage).toHaveBeenCalledWith(location);
    expect(mocks.deleteSession.mock.calls).toEqual([
      ['grandchild', 'workspace-remote'],
      ['child', 'workspace-remote'],
    ]);
    expect(mocks.discard.mock.calls).toEqual([['grandchild'], ['child']]);
    expect(mocks.clearIntent.mock.calls).toEqual([['grandchild'], ['child']]);
  });

  it('keeps failed descendants and their parent available for retry', async () => {
    mocks.deleteSession.mockRejectedValue(new Error('offline'));
    await expect(deleteSessionTreeBranch(location)).rejects.toThrow('offline');
    expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('does not delete against another peer after the lineage request', async () => {
    mocks.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('surface changed'); });
    await expect(deleteSessionTreeBranch(location)).rejects.toThrow('surface changed');
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('does not discard another peer projection after a successful backend deletion', async () => {
    mocks.deleteSession.mockImplementationOnce(async () => {
      mocks.assertCurrent.mockImplementation(() => { throw new Error('surface changed'); });
    });
    await expect(deleteSessionTreeBranch(location)).rejects.toThrow('surface changed');
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('refuses deletion without a complete lineage response', async () => {
    mocks.lineage.mockResolvedValue(null);
    await expect(deleteSessionTreeBranch(location)).rejects.toThrow('lineage is unavailable');
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});
