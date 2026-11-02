/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppInstanceSnapshot, MiniAppViewTicket } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { MiniAppPresence } from './MiniAppPresence';
import { ensureMiniAppTab, useMiniAppPresentationStore } from './miniAppPresentationStore';

const host = vi.hoisted(() => ({ snapshot: vi.fn(), heartbeat: vi.fn(), open: vi.fn(), local: true,
  closeScene: vi.fn(), openScene: vi.fn(), closing: false,
  listener: undefined as ((snapshot: MiniAppInstanceSnapshot) => void) | undefined,
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { listen: (_event: string, listener: typeof host.listener) => {
  host.listener = listener; return () => { host.listener = undefined; };
} } }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({
  hasLocalMiniAppPresentation: () => host.local, miniAppPresentationAPI: host,
}));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ closeScene: host.closeScene, openScene: host.openScene }) } }));
vi.mock('./miniAppLifecycle', () => ({ isMiniAppClosing: () => host.closing }));

const ticket: MiniAppViewTicket = {
  instance: { instanceId: 'instance', appId: 'notes', workspacePath: null,
    primaryView: { viewId: 'window', kind: 'window' }, pendingView: { viewId: 'tab', kind: 'tab' }, contentCapabilities: [] },
  view: { viewId: 'tab', kind: 'tab' },
};
const snapshot = (revision: number, instances = [ticket.instance]): MiniAppInstanceSnapshot => ({
  protocolVersion: 1, hostEpoch: 'host', revision, instances,
});
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks(); host.local = true; host.closing = false;
  useMiniAppPresentationStore.setState({ snapshot: null, tabs: {} });
  host.snapshot.mockResolvedValue(snapshot(0, []));
  host.heartbeat.mockResolvedValue(ticket.instance);
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<MiniAppPresence />); });
});
afterEach(() => { act(() => root.unmount()); });

describe('MiniApp presence during view closure', () => {
  it('retains the returned tab ticket until scene removal, preventing an automatic reopen', async () => {
    act(() => host.listener!(snapshot(1)));
    expect(host.openScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
    const closingSnapshot = snapshot(3, [{ ...ticket.instance, primaryView: null, pendingView: null }]);
    let finish!: () => void;
    host.closeScene.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    act(() => host.listener!(closingSnapshot));
    // This is the old race: the mounted scene reacts to a missing ticket and
    // ensures its tab again before asynchronous scene navigation has completed.
    expect((await ensureMiniAppTab('notes')).view.viewId).toBe('tab');
    expect(host.open).not.toHaveBeenCalled();
    expect(host.closeScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
    act(() => {
      useMiniAppPresentationStore.getState().release('notes');
      finish();
      host.listener!(snapshot(2));
    });
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
    expect(host.openScene).toHaveBeenCalledTimes(1);
  });

  it('closes a retired instance without discarding its ticket before closeScene commits', () => {
    act(() => host.listener!(snapshot(1)));
    act(() => host.listener!(snapshot(2, [])));
    expect(host.closeScene).toHaveBeenCalledExactlyOnceWith('miniapp:notes');
    expect(useMiniAppPresentationStore.getState().tabs.notes.view.viewId).toBe('tab');
  });

  it('never rehydrates a tab while its explicit close is draining accepted operations', () => {
    host.closing = true;
    act(() => host.listener!(snapshot(1)));
    expect(host.openScene).not.toHaveBeenCalled();
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
  });

  it('keeps the committed destination tab when the original window closes late', () => {
    act(() => host.listener!(snapshot(1)));
    act(() => host.listener!(snapshot(2, [{ ...ticket.instance, primaryView: ticket.view, pendingView: null }])));
    expect(host.closeScene).not.toHaveBeenCalled();
    expect(useMiniAppPresentationStore.getState().tabs.notes.view.kind).toBe('tab');
  });

  it('does not mutate tabs on a peer surface', () => {
    host.local = false;
    act(() => host.listener!(snapshot(1)));
    expect(host.openScene).not.toHaveBeenCalled();
    expect(host.closeScene).not.toHaveBeenCalled();
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
  });
});
