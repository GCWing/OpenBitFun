import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
const invoke = vi.hoisted(() => vi.fn(async (_command, prepare) => prepare()));
vi.mock('@/infrastructure/api/service-api/invokePrepared', () => ({ invokePrepared: invoke }));
import { loadTrajectoryCatalog, loadTrajectoryPage } from './trajectoryApi';
const session = { sessionId: 's', workspaceId: 'ssh-workspace', workspacePath: '/home/remote/project', remoteConnectionId: 'ssh-host',
  turnCatalog: { sessionId: 's', revision: 'rev', entries: [{ ordinal: 9, storageTurnIndex: 42, turnId: 'stable' }] },
} as unknown as Session;
describe('trajectory transport scope', () => {
  it('retains SSH ownership and stable host identities in bounded page requests', async () => {
    const payload = await loadTrajectoryPage(session, 9, 'needle', 256);
    expect(invoke).toHaveBeenCalledWith('load_session_trajectory', expect.any(Function));
    expect(payload).toEqual({ request: { sessionId: 's', workspaceId: 'ssh-workspace', workspacePath: '/home/remote/project',
      remoteConnectionId: 'ssh-host', expectedCatalogRevision: 'rev', expectedTurnId: 'stable', targetStorageTurnIndex: 42,
      before: 0, after: 8, nodeOffset: 256, query: 'needle' } });
  });
  it('discovers a host catalog without adopting a peer replica revision or controller path', async () => {
    expect(await loadTrajectoryCatalog(session)).toEqual({ request: { sessionId: 's', workspaceId: 'ssh-workspace',
      workspacePath: '/home/remote/project', remoteConnectionId: 'ssh-host', targetStorageTurnIndex: 0, catalogOnly: true } });
    await expect(loadTrajectoryPage(session, 1, '')).rejects.toThrow('unavailable');
  });
});
