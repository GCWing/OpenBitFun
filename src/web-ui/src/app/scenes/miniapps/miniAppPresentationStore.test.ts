import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detachMiniAppTab, ensureMiniAppTab, useMiniAppPresentationStore } from './miniAppPresentationStore';
import type { MiniAppInstanceSnapshot, MiniAppViewTicket } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';

const native = vi.hoisted(() => ({ open: vi.fn(), detach: vi.fn(), local: true }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({
  hasLocalMiniAppPresentation: () => native.local,
  miniAppPresentationAPI: { open: native.open, detach: native.detach },
}));
const ticket: MiniAppViewTicket = {
  instance: { instanceId: 'instance', appId: 'notes', workspacePath: '/pinned', primaryView: null,
    pendingView: { viewId: 'tab', kind: 'tab' }, contentCapabilities: [] },
  view: { viewId: 'tab', kind: 'tab' },
};
const snapshot = (hostEpoch: string, revision: number): MiniAppInstanceSnapshot => ({
  protocolVersion: 1, hostEpoch, revision, instances: [ticket.instance],
});

describe('MiniApp presentation replica', () => {
  beforeEach(() => {
    vi.resetAllMocks(); native.local = true;
    useMiniAppPresentationStore.setState({ snapshot: null, tabs: {} });
    native.detach.mockResolvedValue(undefined);
  });
  it('deduplicates concurrent tab mounts and keeps the original workspace binding', async () => {
    native.open.mockResolvedValue(ticket);
    const [a, b] = await Promise.all([ensureMiniAppTab('notes', '/pinned'), ensureMiniAppTab('notes', '/pinned')]);
    expect(a).toEqual(b);
    expect(native.open).toHaveBeenCalledTimes(1);
    expect((await ensureMiniAppTab('notes', '/changed')).instance.workspacePath).toBe('/pinned');
  });
  it('ignores late snapshots and drops obsolete tickets after a host restart', () => {
    const state = useMiniAppPresentationStore.getState();
    state.apply(snapshot('host-1', 5)); state.bind(ticket); state.apply(snapshot('host-1', 2));
    expect(useMiniAppPresentationStore.getState().snapshot?.revision).toBe(5);
    state.apply(snapshot('host-2', 0));
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
  });
  it('keeps the close ticket until view removal commits and never detaches on a peer surface', async () => {
    useMiniAppPresentationStore.getState().bind(ticket);
    expect(await detachMiniAppTab('notes')).toBe(true);
    expect(native.detach).toHaveBeenCalledExactlyOnceWith(ticket);
    expect(useMiniAppPresentationStore.getState().tabs.notes).toEqual(ticket);
    native.local = false;
    expect(await detachMiniAppTab('notes')).toBe(false);
    expect(native.detach).toHaveBeenCalledTimes(1);
  });
  it('commits the close revision before release so a late snapshot cannot resurrect the tab', async () => {
    const state = useMiniAppPresentationStore.getState();
    state.apply(snapshot('host', 2)); state.bind(ticket);
    native.detach.mockResolvedValue({ ...snapshot('host', 3), instances: [] });
    await detachMiniAppTab('notes');
    expect(useMiniAppPresentationStore.getState().tabs.notes).toEqual(ticket);
    state.release('notes');
    state.apply(snapshot('host', 2));
    expect(useMiniAppPresentationStore.getState().snapshot?.instances).toEqual([]);
    expect(useMiniAppPresentationStore.getState().tabs).toEqual({});
  });
  it('closes a tab while its initial presentation request is still in flight', async () => {
    let finish!: (value: MiniAppViewTicket) => void;
    native.open.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const opening = ensureMiniAppTab('notes');
    const closing = detachMiniAppTab('notes');
    expect(native.detach).not.toHaveBeenCalled();
    finish(ticket);
    await opening;
    expect(await closing).toBe(true);
    expect(native.detach).toHaveBeenCalledExactlyOnceWith(ticket);
  });
});
