// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
const mocks = vi.hoisted(() => ({ page: vi.fn(), catalog: vi.fn(), peer: false, supported: false, current: true }));
vi.mock('./trajectoryApi', () => ({ loadTrajectoryPage: mocks.page, loadTrajectoryCatalog: mocks.catalog }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => ({
  peerMode: { active: mocks.peer }, currentPeerCapabilities: { sessionTrajectoryV1: mocks.supported },
}) }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => {
  const scope = { epoch: 1, isCurrent: () => mocks.current };
  return { getActiveSurfaceScope: () => scope };
});
import { useTrajectory } from './useTrajectory';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const catalog = { schemaVersion: 1, sessionId: 'session', revision: 'host', totalTurnCount: 2, complete: true,
  entries: [{ ordinal: 0, storageTurnIndex: 5, turnId: 'a' }, { ordinal: 1, storageTurnIndex: 9, turnId: 'b' }] };
const session = { sessionId: 'session', workspaceId: 'workspace', workspacePath: '/remote', dialogTurns: [], isPartial: true } as unknown as Session;
let result: ReturnType<typeof useTrajectory>;
function Harness({ query = '', value = session }: { query?: string; value?: Session }) { result = useTrajectory(value, query); return null; }
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); mocks.page.mockReset(); mocks.catalog.mockReset(); mocks.current = true; mocks.peer = false; mocks.supported = true;
  mocks.catalog.mockResolvedValue({ status: 'catalog', catalog });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

describe('trajectory history reader', () => {
  it('leaves old peers on an explicit partial view without invoking a new command', async () => {
    mocks.peer = true; mocks.supported = false;
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.page).not.toHaveBeenCalled();
    expect(result.supported).toBe(false); expect(result.complete).toBe(false);
  });
  it('discovers the host catalog independently of a partial peer replica and respects node pagination', async () => {
    mocks.peer = true;
    mocks.page.mockResolvedValueOnce({ status: 'ready', nodes: [{ id: 'a', turnId: 'a', turnOrdinal: 0 }], nextNodeOffset: 256, endOrdinalExclusive: 2 })
      .mockResolvedValueOnce({ status: 'ready', nodes: [{ id: 'b', turnId: 'b', turnOrdinal: 1 }], nextNodeOffset: null, endOrdinalExclusive: 2 });
    await act(async () => root.render(<Harness />));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mocks.page).toHaveBeenNthCalledWith(1, expect.objectContaining({ turnCatalog: catalog }), 0, '', 0);
    expect(mocks.page).toHaveBeenNthCalledWith(2, expect.anything(), 0, '', 256);
    expect(result.nodes).toHaveLength(2); expect(result.complete).toBe(true);
  });
  it('ignores a delayed old query and stops paging after a surface change', async () => {
    let finish!: (value: unknown) => void;
    mocks.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Harness query="old" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => root.render(<Harness query="new" />));
    mocks.current = false;
    await act(async () => finish({ status: 'ready', nodes: [{ id: 'old' }], nextNodeOffset: null, endOrdinalExclusive: 1 }));
    expect(result.nodes).toHaveLength(0); expect(mocks.page).toHaveBeenCalledTimes(1);
  });
  it('keeps summary reads stable when the live session snapshot changes', async () => {
    mocks.page.mockResolvedValue({ status: 'ready', nodes: [], nextNodeOffset: null, endOrdinalExclusive: 2 });
    await act(async () => root.render(<Harness />));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => root.render(<Harness value={{ ...session, dialogTurns: [...session.dialogTurns] }} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
    expect(mocks.page).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
  });
});
