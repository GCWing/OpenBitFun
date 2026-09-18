import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/flow_chat/types/flow-chat';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { dockConversationKey, useConversationDockStore } from '@/app/stores/conversationDockStore';
import { sessionSceneWorkspaceKey } from '@/app/services/sessionSceneTarget';
import { useMiniAppStore } from './miniAppStore';
import { followMiniAppConversation, openMiniAppConversation, openMiniAppFromConversation, resolveMiniAppConversation, syncMiniAppConversations } from './miniAppConversation';

const fixture = vi.hoisted(() => ({ sessions: new Map<string, Session>(), openScene: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: fixture.sessions }) } }));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ openScene: fixture.openScene }) } }));

/** MiniApp sessions are owned by a workspace record; the dock groups them by that record's ID, never by a folder path. */
function bind(appId: string, sessionId = appId, surfaceId = 'local') {
  fixture.sessions.set(sessionId, {
    sessionId,
    workspaceId: `workspace-${appId}`,
    workspacePath: `/apps/${appId}`,
    config: {},
    dialogTurns: [],
  } as unknown as Session);
  useMiniAppStore.getState().claimComposer(appId, { surfaceId, token: `${appId}#1`, sessionId });
}

describe('MiniApp and conversation navigation', () => {
  beforeEach(() => {
    activateSurface('local'); fixture.sessions.clear(); fixture.openScene.mockClear();
    useMiniAppStore.setState(useMiniAppStore.getInitialState());
    useConversationDockStore.setState(useConversationDockStore.getInitialState());
  });

  it('restores the same conversation and draft after Hide without duplicating or creating sessions', () => {
    bind('slides'); openMiniAppConversation('slides');
    const dock = useConversationDockStore.getState();
    const key = dockConversationKey(dock.entries[0]);
    dock.setDraft(key, 'Keep this draft');
    dock.hide(key);
    syncMiniAppConversations();
    expect(useConversationDockStore.getState().entries).toEqual([]);
    expect(useMiniAppStore.getState().composerClaims.slides.sessionId).toBe('slides');
    expect(openMiniAppConversation('slides')).toBe(true);
    expect(openMiniAppConversation('slides')).toBe(true);
    expect(useConversationDockStore.getState().entries).toHaveLength(1);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(key);
    expect(useConversationDockStore.getState().drafts[key].text).toBe('Keep this draft');
    expect(fixture.sessions.size).toBe(1);
  });

  it('registers background apps silently and preserves explicit collapse across topic changes', () => {
    bind('slides'); syncMiniAppConversations();
    expect(useConversationDockStore.getState().open).toBe(false);
    openMiniAppConversation('slides');
    useConversationDockStore.getState().setOpen(false);
    bind('slides', 'second-deck'); syncMiniAppConversations();
    expect(useConversationDockStore.getState().open).toBe(false);
    expect(useConversationDockStore.getState().entries).toHaveLength(1);
    expect(useConversationDockStore.getState().entries[0].sessionId).toBe('second-deck');
  });

  it('keeps Hide independent from runner token changes', () => {
    bind('slides'); openMiniAppConversation('slides');
    useConversationDockStore.getState().hide(dockConversationKey(resolveMiniAppConversation('slides')!));
    useMiniAppStore.getState().claimComposer('slides', { token: 'slides#2', sessionId: 'slides' });
    syncMiniAppConversations();
    expect(useConversationDockStore.getState().entries).toEqual([]);
    openMiniAppConversation('slides');
    expect(useConversationDockStore.getState().entries[0].claimToken).toBe('slides#2');
  });

  it('follows main app navigation only from an expanded MiniApp conversation', () => {
    bind('slides'); bind('chart'); syncMiniAppConversations(); openMiniAppConversation('slides');
    const slides = dockConversationKey(resolveMiniAppConversation('slides')!);
    const chart = dockConversationKey(resolveMiniAppConversation('chart')!);
    followMiniAppConversation('chart', true);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(slides);
    followMiniAppConversation('chart', false);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(chart);
    const dock = useConversationDockStore.getState();
    dock.setOpen(false); followMiniAppConversation('slides', false);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(chart);
    dock.setOpen(true);
    dock.add({ kind: 'session', sessionId: 'regular', workspaceKey: 'repo', surfaceId: 'local' });
    followMiniAppConversation('slides', false);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe('["local","regular"]');
  });

  it('does not follow a hidden app or an app without a bound conversation', () => {
    bind('slides'); bind('chart'); syncMiniAppConversations(); openMiniAppConversation('slides');
    useConversationDockStore.getState().hide(dockConversationKey(resolveMiniAppConversation('chart')!));
    followMiniAppConversation('chart', false); followMiniAppConversation('unknown', false);
    expect(useConversationDockStore.getState().entries.map(entry => entry.appId)).toEqual(['slides']);
    expect(openMiniAppConversation('unknown')).toBe(false);
  });

  it('returns to the owning application and rejects references from other devices', () => {
    bind('slides'); const entry = resolveMiniAppConversation('slides')!;
    expect(entry.workspaceKey).toBe(sessionSceneWorkspaceKey('workspace-slides'));
    expect(entry.workspaceKey).not.toContain('/apps/slides');
    openMiniAppFromConversation(entry);
    expect(fixture.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:slides');
    activateSurface('peer');
    expect(openMiniAppConversation('slides')).toBe(false);
    openMiniAppFromConversation(entry); syncMiniAppConversations();
    expect(fixture.openScene).toHaveBeenCalledTimes(1);
    expect(useConversationDockStore.getState().entries).toEqual([]);
  });
});
