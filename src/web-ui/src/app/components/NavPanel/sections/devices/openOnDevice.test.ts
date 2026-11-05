import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prewarm: vi.fn(),
  sessions: new Map<string, unknown>(),
  adopt: vi.fn(async (_workspaceId: string, sessions: Array<{ sessionId: string }>) => {
    for (const session of sessions) mocks.sessions.set(session.sessionId, session);
  }),
  intent: vi.fn(),
  hold: vi.fn(),
  clearIntent: vi.fn(),
  promote: vi.fn(async () => undefined),
  ensureMetadata: vi.fn(async () => true),
  clearUnread: vi.fn(),
  openMainSession: vi.fn(async () => undefined),
  createChatDraft: vi.fn(async () => 'new-session'),
  openLatestAssistant: vi.fn(async () => undefined),
  workspaces: new Map<string, { id: string; workspaceKind: string; rootPath: string }>(),
  archiveRow: vi.fn(async () => undefined),
  duplicateRow: vi.fn(async () => undefined),
  renameRow: vi.fn(async () => undefined),
  worktreeRow: vi.fn(async () => undefined),
  isRunning: vi.fn(() => false),
  capabilities: null as null | { wholeSessionCopyV1?: boolean },
  canReveal: vi.fn(() => false),
  reveal: vi.fn(async () => undefined),
  exportMarkdown: vi.fn(async () => ({ status: 'saved' })),
}));
vi.mock('../sessions/sessionRowActions', () => ({
  archiveSessionRow: mocks.archiveRow,
  duplicateSessionRow: mocks.duplicateRow,
  renameSessionRow: mocks.renameRow,
  openWorktreeWorkspaceRow: mocks.worktreeRow,
}));
vi.mock('@/flow_chat/services/sessionNavStatusService', () => ({ sessionNavStatusService: { isRunning: mocks.isRunning } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => (mocks.capabilities ? { getState: () => ({ capabilities: mocks.capabilities }) } : undefined) },
}));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: { canRevealStorageDirectory: mocks.canReveal, revealStorageDirectory: mocks.reveal },
}));
vi.mock('@/flow_chat/services/sessionMarkdownExport', () => ({ exportSessionToMarkdown: mocks.exportMarkdown }));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    ensurePersistedSessionMetadata: mocks.ensureMetadata,
    clearSessionUnreadCompletion: mocks.clearUnread,
    adoptHostSessionMetadata: mocks.adopt,
    promoteSeededSessions: mocks.promote,
    getState: () => ({ sessions: mocks.sessions }),
  },
}));
vi.mock('@/flow_chat/services/sessionOpenIntent', () => ({
  dispatchHistorySessionOpenIntent: mocks.intent,
  clearHistorySessionOpenTransition: mocks.clearIntent,
}));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ holdSessionScene: mocks.hold }) } }));
vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: { createChatDraft: mocks.createChatDraft } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: mocks.openMainSession }));
vi.mock('@/flow_chat/services/RelaySessionHistory', () => ({ prewarmRelaySessionHistory: mocks.prewarm }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({ openedWorkspaces: mocks.workspaces }), setActiveWorkspace: vi.fn() },
}));
vi.mock('@/app/utils/projectSessionWorkspace', () => ({
  findReusableEmptySessionId: () => null,
  flowChatSessionConfigForWorkspace: (workspace: { id: string }) => ({ workspaceId: workspace.id }),
}));
vi.mock('../workspaces/openLatestAssistantSession', () => ({ openLatestAssistantSession: mocks.openLatestAssistant }));
vi.mock('@/shared/types', () => ({ WorkspaceKind: { Assistant: 'assistant', Normal: 'normal', Remote: 'remote' } }));

import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';
import type { PeerDeviceContextValue } from '@/infrastructure/peer-device/peerDeviceContextState';
import { activateDeviceSlot, createDeviceSession, openDeviceAssistant, openDeviceSession, runDeviceSessionAction } from './openOnDevice';
import type { SidebarDeviceSlot } from './useSidebarDevices';

const peerSlot: SidebarDeviceSlot = {
  surfaceId: 'peer-a', deviceId: 'peer-a', name: 'Studio Mac', isLocal: false,
  rendered: false, hostKind: 'desktop', controllable: true,
};
const localSlot: SidebarDeviceSlot = { ...peerSlot, surfaceId: 'local', deviceId: 'me', name: 'Laptop', isLocal: true };

function peerContext(outcome: 'activated' | 'superseded' = 'activated') {
  return {
    switchToDevice: vi.fn(async (deviceId: string) => {
      if (outcome === 'activated') activateSurface(surfaceIdForDevice(deviceId));
      return outcome;
    }),
    switchToLocal: vi.fn(async () => {
      if (outcome === 'activated') activateSurface(surfaceIdForDevice(null));
      return outcome;
    }),
  } as unknown as PeerDeviceContextValue & {
    switchToDevice: ReturnType<typeof vi.fn>;
    switchToLocal: ReturnType<typeof vi.fn>;
  };
}

describe('openOnDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDeviceSurfaceForTest();
    mocks.workspaces.clear();
    mocks.sessions.clear();
    mocks.workspaces.set('ws-1', { id: 'ws-1', workspaceKind: 'normal', rootPath: '/p' });
    mocks.capabilities = null;
  });

  it('does not switch when the device is already rendered', async () => {
    const peer = peerContext();
    expect(await activateDeviceSlot(peer, localSlot)).toBe('activated');
    expect(peer.switchToLocal).not.toHaveBeenCalled();
    expect(peer.switchToDevice).not.toHaveBeenCalled();
  });

  it('opens the chosen row without waiting for all device seeds to be promoted', async () => {
    mocks.sessions.set('s-1', { sessionId: 's-1' });
    const peer = peerContext();
    await openDeviceSession(peer, peerSlot, 'ws-1', { sessionId: 's-1' }, 'Title');
    expect(mocks.hold).toHaveBeenCalledWith({ surfaceId: 'peer-a', workspaceKey: '["workspace","ws-1"]', sessionId: 's-1' });
    expect(mocks.hold.mock.invocationCallOrder[0]).toBeLessThan(peer.switchToDevice.mock.invocationCallOrder[0]);
    expect(mocks.intent.mock.invocationCallOrder[0]).toBeLessThan(peer.switchToDevice.mock.invocationCallOrder[0]);
    expect(peer.switchToDevice).toHaveBeenCalledWith('peer-a', 'Studio Mac');
    // The session's stream starts before the switch, not after it.
    expect(mocks.prewarm).toHaveBeenCalledWith('peer-a', 's-1');
    expect(mocks.prewarm.mock.invocationCallOrder[0]).toBeLessThan(peer.switchToDevice.mock.invocationCallOrder[0]);
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.adopt).not.toHaveBeenCalled();
    expect(mocks.ensureMetadata).not.toHaveBeenCalled();
    expect(mocks.openMainSession).toHaveBeenCalledWith('s-1', expect.objectContaining({ workspaceId: 'ws-1' }));
  });

  it('adopts the row record when the session was not seeded yet', async () => {
    await openDeviceSession(peerContext(), peerSlot, 'ws-1', { sessionId: 's-2', createdAt: 1 } as never);
    expect(mocks.adopt).toHaveBeenCalledWith('ws-1', [{ sessionId: 's-2', createdAt: 1 }]);
    expect(mocks.openMainSession).toHaveBeenCalledWith('s-2', expect.anything());
  });

  it('fails loudly and clears the overlay when the host no longer has the session', async () => {
    mocks.adopt.mockImplementationOnce(async () => undefined);
    await expect(openDeviceSession(peerContext(), peerSlot, 'ws-1', { sessionId: 'gone', createdAt: 1 } as never))
      .rejects.toThrow('common:nav.devices.sessionUnavailable');
    expect(mocks.clearIntent).toHaveBeenCalledWith('gone');
    expect(mocks.openMainSession).not.toHaveBeenCalled();
  });

  it('returns to this machine through the local switch', async () => {
    activateSurface(surfaceIdForDevice('peer-a'));
    const peer = peerContext();
    mocks.sessions.set('s-1', { sessionId: 's-1' });
    await openDeviceSession(peer, localSlot, 'ws-1', { sessionId: 's-1' } as never);
    expect(peer.switchToLocal).toHaveBeenCalledOnce();
    expect(mocks.openMainSession).toHaveBeenCalledOnce();
  });

  it('opens nothing when a newer switch superseded this one', async () => {
    const peer = peerContext('superseded');
    await openDeviceSession(peer, peerSlot, 'ws-1', { sessionId: 's-1' } as never);
    expect(mocks.clearIntent).toHaveBeenCalledWith('s-1');
    await openDeviceAssistant(peer, peerSlot, 'ws-1');
    await createDeviceSession(peer, peerSlot, 'ws-1');
    expect(mocks.adopt).not.toHaveBeenCalled();
    expect(mocks.openLatestAssistant).not.toHaveBeenCalled();
    expect(mocks.createChatDraft).not.toHaveBeenCalled();
  });

  it('creates a session with the live workspace of the rendered device', async () => {
    const peer = peerContext();
    await createDeviceSession(peer, peerSlot, 'ws-1');
    expect(mocks.createChatDraft).toHaveBeenCalledWith({ workspaceId: 'ws-1' }, undefined);
    expect(mocks.openMainSession).toHaveBeenCalledWith('new-session', expect.objectContaining({ workspaceId: 'ws-1' }));
  });

  it('fails loudly when the workspace is gone on the device', async () => {
    const peer = peerContext();
    await expect(createDeviceSession(peer, peerSlot, 'missing')).rejects.toThrow('missing');
  });

  describe('session row actions', () => {
    const t = (key: string) => key;
    const seeded = { sessionId: 's-1', workspaceId: 'ws-1', config: {} };

    it('renders the device first, then runs the live handler on it', async () => {
      mocks.sessions.set('s-1', seeded);
      const peer = peerContext();
      for (const action of [
        { kind: 'archive' as const },
        { kind: 'rename' as const, title: 'Renamed' },
        { kind: 'open-worktree' as const, worktreePath: '/wt' },
      ]) await runDeviceSessionAction(peer, peerSlot, 's-1', action, t);
      await runDeviceSessionAction(peer, peerSlot, 's-1', { kind: 'export', scope: 'full', title: 'Chat' }, t);
      expect(peer.switchToDevice).toHaveBeenCalledWith('peer-a', 'Studio Mac');
      const switchedAt = peer.switchToDevice.mock.invocationCallOrder[0];
      expect(mocks.promote.mock.invocationCallOrder[0]).toBeGreaterThan(switchedAt);
      expect(mocks.archiveRow).toHaveBeenCalledWith('s-1', t);
      expect(mocks.archiveRow.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.promote.mock.invocationCallOrder[0]);
      expect(mocks.renameRow).toHaveBeenCalledWith('s-1', 'Renamed', t);
      expect(mocks.worktreeRow).toHaveBeenCalledWith('/wt', t);
      expect(mocks.exportMarkdown).toHaveBeenCalledWith({ sessionId: 's-1', title: 'Chat', workspaceId: 'ws-1' }, 'full');
    });

    it('runs nothing when a newer switch superseded the action', async () => {
      mocks.sessions.set('s-1', seeded);
      await runDeviceSessionAction(peerContext('superseded'), peerSlot, 's-1', { kind: 'archive' }, t);
      expect(mocks.archiveRow).not.toHaveBeenCalled();
    });

    it('fails loudly when the rendered device no longer has the session', async () => {
      await expect(runDeviceSessionAction(peerContext(), peerSlot, 'gone', { kind: 'archive' }, t))
        .rejects.toThrow('common:nav.devices.sessionUnavailable');
      expect(mocks.archiveRow).not.toHaveBeenCalled();
    });

    it('re-checks copy gates on the rendered device instead of faking success', async () => {
      mocks.sessions.set('s-1', seeded);
      mocks.capabilities = { wholeSessionCopyV1: false };
      await expect(runDeviceSessionAction(peerContext(), peerSlot, 's-1', { kind: 'duplicate' }, t))
        .rejects.toThrow('nav.sessions.duplicateHostUnsupported');
      mocks.capabilities = { wholeSessionCopyV1: true };
      mocks.isRunning.mockReturnValueOnce(true);
      await expect(runDeviceSessionAction(peerContext(), peerSlot, 's-1', { kind: 'duplicate' }, t))
        .rejects.toThrow('nav.sessions.duplicateRunning');
      expect(mocks.duplicateRow).not.toHaveBeenCalled();
      await runDeviceSessionAction(peerContext(), peerSlot, 's-1', { kind: 'duplicate' }, t);
      expect(mocks.duplicateRow).toHaveBeenCalledWith('s-1', t);
    });

    it('opens a storage directory only where the rendered surface can', async () => {
      mocks.sessions.set('s-1', seeded);
      await expect(runDeviceSessionAction(peerContext(), peerSlot, 's-1', { kind: 'reveal-storage' }, t))
        .rejects.toThrow('nav.sessions.storageDirectoryDesktopOnly');
      expect(mocks.reveal).not.toHaveBeenCalled();
      activateSurface(surfaceIdForDevice('peer-a'));
      mocks.canReveal.mockReturnValueOnce(true);
      await runDeviceSessionAction(peerContext(), localSlot, 's-1', { kind: 'reveal-storage' }, t);
      expect(mocks.reveal).toHaveBeenCalledWith('ws-1', 's-1');
    });
  });
});
