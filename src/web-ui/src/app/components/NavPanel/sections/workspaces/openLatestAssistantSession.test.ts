import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  loadPage: vi.fn(),
  createDraft: vi.fn(),
  open: vi.fn(),
  clearUnread: vi.fn(),
  readDefault: vi.fn(),
  ensureMetadata: vi.fn(),
}));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: mocks.sessions }),
    loadSessionMetadataPage: mocks.loadPage,
    clearSessionUnreadCompletion: mocks.clearUnread,
    ensurePersistedSessionMetadata: mocks.ensureMetadata,
  },
}));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  flowChatManager: { createChatDraft: mocks.createDraft },
}));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: mocks.open }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {} }));
vi.mock('./assistantSessionPreferences', () => ({ readAssistantDefaultSession: mocks.readDefault }));

import { openLatestAssistantSession } from './openLatestAssistantSession';

const workspace = {
  id: 'assistant', name: 'Assistant', rootPath: '/peer/assistant',
  workspaceKind: WorkspaceKind.Assistant,
} as WorkspaceInfo;
const activateWorkspace = vi.fn();
const session = (id: string, activity: number, extra: Partial<Session> = {}): Session => ({
  sessionId: id, workspaceId: workspace.id, createdAt: activity, lastActiveAt: activity,
  sessionKind: 'normal', config: {}, ...extra,
} as Session);
const page = (sessions: Session[], extra = {}) => ({
  sessions: sessions.map(value => ({ sessionId: value.sessionId, lastActiveAt: value.lastActiveAt })),
  hasMore: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetDeviceSurfaceForTest();
  mocks.sessions.clear();
  mocks.loadPage.mockReset().mockResolvedValue(page([]));
  mocks.createDraft.mockResolvedValue('new-draft');
  mocks.readDefault.mockResolvedValue({ supported: true, sessionId: null });
  mocks.ensureMetadata.mockResolvedValue(true);
});

describe('assistant latest session navigation', () => {
  it('opens a persisted default before considering more recent sessions', async () => {
    mocks.readDefault.mockResolvedValue({ supported: true, sessionId: 'preferred' });
    mocks.ensureMetadata.mockImplementationOnce(async () => {
      mocks.sessions.set('preferred', session('preferred', 10));
      mocks.sessions.set('newer', session('newer', 100));
      return true;
    });
    await openLatestAssistantSession(workspace, activateWorkspace);
    expect(mocks.ensureMetadata).toHaveBeenCalledWith('preferred', workspace.id);
    expect(mocks.open).toHaveBeenCalledWith('preferred', expect.anything());
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it('reports an unavailable default and falls back without removing the preference', async () => {
    mocks.readDefault.mockResolvedValue({ supported: true, sessionId: 'deleted' });
    mocks.ensureMetadata.mockResolvedValueOnce(false);
    mocks.sessions.set('latest', session('latest', 10));
    const unavailable = vi.fn();
    await openLatestAssistantSession(workspace, activateWorkspace, unavailable);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith('latest', expect.anything());
  });

  it('keeps latest-session navigation available on older hosts without the preference contract', async () => {
    mocks.readDefault.mockResolvedValue({ supported: false, sessionId: null });
    mocks.sessions.set('latest', session('latest', 10));
    await openLatestAssistantSession(workspace, activateWorkspace);
    expect(mocks.open).toHaveBeenCalledWith('latest', expect.anything());
  });

  it('loads persisted history on demand and opens the latest main session in the owning workspace', async () => {
    const latest = session('latest', 20);
    const child = session('child', 100, { sessionKind: 'btw', parentSessionId: latest.sessionId });
    const archived = session('archived', 200, { persistedStatus: 'archived' });
    const unrelated = session('other-workspace', 300, { workspaceId: 'other' });
    mocks.loadPage.mockImplementationOnce(async () => {
      for (const value of [latest, child, archived, unrelated]) mocks.sessions.set(value.sessionId, value);
      return page([latest, child]);
    });

    await openLatestAssistantSession(workspace, activateWorkspace);

    expect(mocks.loadPage).toHaveBeenCalledWith(workspace.id, 1, undefined, 'assistant_nav_latest');
    expect(mocks.open).toHaveBeenCalledWith('latest', expect.objectContaining({
      workspaceId: workspace.id, activateWorkspace,
    }));
    expect(mocks.clearUnread).toHaveBeenCalledWith('latest');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('resumes a newer in-memory draft instead of an older saved session', async () => {
    const saved = session('saved', 10);
    const draft = session('draft', 20);
    for (const value of [saved, draft]) mocks.sessions.set(value.sessionId, value);
    mocks.loadPage.mockResolvedValue(page([saved]));
    await openLatestAssistantSession(workspace, activateWorkspace);
    expect(mocks.open).toHaveBeenCalledWith('draft', expect.anything());
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('creates a Claw draft only after a successful empty history read on the selected peer', async () => {
    activateSurface('peer-device');
    await openLatestAssistantSession(workspace, activateWorkspace);
    expect(mocks.createDraft).toHaveBeenCalledWith({
      workspaceId: workspace.id, workspacePath: '/peer/assistant',
    }, 'Claw');
    expect(mocks.open).toHaveBeenCalledWith('new-draft', expect.objectContaining({ workspaceId: workspace.id }));
  });

  it('propagates offline errors without creating a replacement session', async () => {
    mocks.loadPage.mockRejectedValue(new Error('Host offline'));
    await expect(openLatestAssistantSession(workspace, activateWorkspace)).rejects.toThrow('Host offline');
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('abandons a pending read when the device surface changes', async () => {
    mocks.loadPage.mockImplementationOnce(async () => {
      activateSurface('another-peer');
      return page([]);
    });
    await expect(openLatestAssistantSession(workspace, activateWorkspace)).rejects.toThrow('Device surface changed');
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('continues past an orphan child instead of opening it as the assistant main session', async () => {
    const child = session('orphan', 20, { sessionKind: 'review', parentSessionId: 'missing' });
    const main = session('main', 10);
    mocks.loadPage.mockImplementationOnce(async () => {
      mocks.sessions.set(child.sessionId, child);
      return page([child], { hasMore: true, nextCursor: 'older' });
    }).mockImplementationOnce(async () => {
      mocks.sessions.set(main.sessionId, main);
      return page([main]);
    });
    await openLatestAssistantSession(workspace, activateWorkspace);
    expect(mocks.loadPage).toHaveBeenLastCalledWith(workspace.id, 1, 'older', 'assistant_nav_latest');
    expect(mocks.open).toHaveBeenCalledWith('main', expect.anything());
  });
});
