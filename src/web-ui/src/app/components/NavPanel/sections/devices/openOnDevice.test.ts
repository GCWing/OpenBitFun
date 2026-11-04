import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
}));

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
import { activateDeviceSlot, createDeviceSession, openDeviceAssistant, openDeviceSession } from './openOnDevice';
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
  });

  it('does not switch when the device is already rendered', async () => {
    const peer = peerContext();
    expect(await activateDeviceSlot(peer, localSlot)).toBe('activated');
    expect(peer.switchToLocal).not.toHaveBeenCalled();
    expect(peer.switchToDevice).not.toHaveBeenCalled();
  });

  it('shows the open overlay at once, promotes seeds after the switch, and opens a seeded session without a read', async () => {
    mocks.sessions.set('s-1', { sessionId: 's-1' });
    const peer = peerContext();
    await openDeviceSession(peer, peerSlot, 'ws-1', { sessionId: 's-1' }, 'Title');
    expect(mocks.hold).toHaveBeenCalledWith({ surfaceId: 'peer-a', workspaceKey: '["workspace","ws-1"]', sessionId: 's-1' });
    expect(mocks.hold.mock.invocationCallOrder[0]).toBeLessThan(peer.switchToDevice.mock.invocationCallOrder[0]);
    expect(mocks.intent.mock.invocationCallOrder[0]).toBeLessThan(peer.switchToDevice.mock.invocationCallOrder[0]);
    expect(peer.switchToDevice).toHaveBeenCalledWith('peer-a', 'Studio Mac');
    expect(mocks.promote).toHaveBeenCalledOnce();
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
});
