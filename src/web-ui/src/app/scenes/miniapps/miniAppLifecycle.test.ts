import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { registerSessionSceneNavigation, useSceneStore } from '@/app/stores/sceneStore';
import { useConversationDockStore } from '@/app/stores/conversationDockStore';
import { useMiniAppStore } from './miniAppStore';
import { beginMiniAppOperation, isMiniAppClosing, requestMiniAppClose, trackMiniAppStream } from './miniAppLifecycle';

const runtime = vi.hoisted(() => ({ stop: vi.fn(), cancel: vi.fn(), cancelStream: vi.fn(), notify: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: {
  workerStop: runtime.stop, agentCancelStaleRuns: runtime.cancel, aiCancel: runtime.cancelStream,
} }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: runtime.notify } }));

const app = { id: 'slides', name: 'Slides', permissions: { node: { enabled: true }, agent: { enabled: true } } } as MiniAppMeta;
const entry = { kind: 'miniapp' as const, surfaceId: 'local', appId: app.id, sessionId: 'deck', claimToken: 'slides#1', workspaceKey: 'app-data' };

describe('explicit MiniApp shutdown', () => {
  beforeEach(() => {
    activateSurface('local'); vi.resetAllMocks();
    runtime.stop.mockResolvedValue(undefined); runtime.cancel.mockResolvedValue({ cancelledRuns: 1 }); runtime.cancelStream.mockResolvedValue(undefined);
    useSceneStore.getState().resetForPeerSwitch();
    useMiniAppStore.setState({ ...useMiniAppStore.getInitialState(), apps: [app], runningWorkerIds: [app.id] });
    useMiniAppStore.getState().claimComposer(app.id, { token: entry.claimToken, sessionId: entry.sessionId });
    useConversationDockStore.setState(useConversationDockStore.getInitialState());
    useConversationDockStore.getState().add(entry);
    useSceneStore.getState().openScene('miniapp:slides');
  });

  it('closes the app, its runs, streams and dock entry through the scene close action', async () => {
    trackMiniAppStream(app.id, 'stream-1', getActiveSurfaceScope(), true);
    runtime.stop.mockImplementation(async () => {
      expect(useSceneStore.getState().openTabs).toHaveLength(1);
      expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(app.id);
    });
    await useSceneStore.getState().closeScene('miniapp:slides');
    expect(runtime.cancelStream).toHaveBeenCalledExactlyOnceWith(app.id, 'stream-1');
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith(app.id);
    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(useMiniAppStore.getState().runningWorkerIds).toEqual([]);
    expect(useMiniAppStore.getState().composerClaims).toEqual({});
    expect(useConversationDockStore.getState().entries).toEqual([]);
  });

  it('retains the app and conversation when a runtime shutdown request fails', async () => {
    runtime.stop.mockRejectedValue(new Error('Peer is offline'));
    await useSceneStore.getState().closeScene('miniapp:slides');
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['miniapp:slides']);
    expect(useMiniAppStore.getState().runningWorkerIds).toContain(app.id);
    expect(useConversationDockStore.getState().entries).toEqual([entry]);
    expect(runtime.notify).toHaveBeenCalledTimes(1);
    expect(isMiniAppClosing(app.id)).toBe(false);
  });

  it('drains accepted starts, rejects new starts and deduplicates repeated close gestures', async () => {
    const finish = beginMiniAppOperation(app.id, getActiveSurfaceScope());
    const close = vi.fn();
    const first = requestMiniAppClose(app.id, close);
    const second = requestMiniAppClose(app.id, close);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(() => beginMiniAppOperation(app.id, getActiveSurfaceScope())).toThrow('MiniApp is closing');
    finish(); await first;
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never stops a different device after an asynchronous surface switch', async () => {
    let finishCancel!: () => void;
    runtime.cancel.mockImplementation(() => new Promise<void>(resolve => { finishCancel = resolve; }));
    const closed = useSceneStore.getState().closeScene('miniapp:slides');
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalled());
    activateSurface('peer'); finishCancel(); await closed;
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.notify).not.toHaveBeenCalled();
    expect(useConversationDockStore.getState().entries).toEqual([entry]);
  });

  it('does not interpret surface teardown as closing an application', () => {
    useSceneStore.getState().resetForPeerSwitch();
    useMiniAppStore.getState().releaseComposer(app.id, entry.claimToken);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it('does not reuse a stale close after returning to the same device', async () => {
    let finishCancel!: () => void;
    runtime.cancel.mockImplementationOnce(() => new Promise<void>(resolve => { finishCancel = resolve; }));
    const oldClose = vi.fn();
    const oldRequest = requestMiniAppClose(app.id, oldClose);
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1));
    activateSurface('peer'); activateSurface('local');
    expect(isMiniAppClosing(app.id)).toBe(false);
    const newClose = vi.fn();
    await requestMiniAppClose(app.id, newClose);
    finishCancel(); await oldRequest;
    expect(newClose).toHaveBeenCalledTimes(1);
    expect(oldClose).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('retires a stopped app even if the fallback session cannot activate', async () => {
    const session = { sessionId: 'regular', surfaceId: 'local', workspaceKey: 'repo' };
    useSceneStore.getState().openSessionScene(session);
    useSceneStore.getState().openScene('miniapp:slides');
    const dispose = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate: async () => false });
    try {
      await useSceneStore.getState().closeScene('miniapp:slides');
      expect(useSceneStore.getState().openTabs.some(tab => tab.id === 'miniapp:slides')).toBe(false);
      expect(useSceneStore.getState().activeTabId).toBeNull();
    } finally { dispose(); }
  });

  it('retires an already deleted app without invoking an invalid runtime resource', async () => {
    trackMiniAppStream(app.id, 'deleted-stream', getActiveSurfaceScope(), true);
    useMiniAppStore.getState().setApps([]);
    await useSceneStore.getState().closeScene('miniapp:slides');
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.cancelStream).not.toHaveBeenCalled();
    expect(useSceneStore.getState().openTabs).toEqual([]);
  });
});
