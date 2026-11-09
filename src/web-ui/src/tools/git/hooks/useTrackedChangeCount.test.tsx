// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { gitEventService } from '../services/GitEventService';
import { useTrackedChangeCount } from './useTrackedChangeCount';

const mocks = vi.hoisted(() => ({
  getTrackedChangeCount: vi.fn<(id: string) => Promise<number>>(),
  peer: vi.fn(),
  desktop: true,
}));
vi.mock('@/infrastructure/api/service-api/GitAPI', () => ({
  gitAPI: { getTrackedChangeCount: mocks.getTrackedChangeCount },
  gitWorkspaceKey: ({ workspaceId }: { workspaceId: string }) => workspaceId,
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: mocks.peer,
}));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => mocks.desktop }));

function Count({ id, remote = false }: { id: string; remote?: boolean }) {
  return <output>{useTrackedChangeCount(id, remote)}</output>;
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('welcome tracked change count', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    vi.useFakeTimers();
    mocks.getTrackedChangeCount.mockReset();
    mocks.peer.mockReturnValue(null);
    mocks.desktop = true;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('coalesces visible readers, caches the result and never polls', async () => {
    mocks.getTrackedChangeCount.mockResolvedValue(3);
    await act(async () => root.render(<><Count id="same" /><Count id="same" /></>));
    expect(mocks.getTrackedChangeCount).not.toHaveBeenCalled();
    await advance(200);
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledExactlyOnceWith('same');
    expect(container.textContent).toBe('33');

    await act(async () => root.render(null));
    await act(async () => root.render(<Count id="same" />));
    await advance(200);
    expect(container.textContent).toBe('3');
    await advance(60_000);
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(1);
  });

  it('refreshes after a scoped operation and ignores its superseded in-flight count', async () => {
    let finishFirst!: (count: number) => void;
    mocks.getTrackedChangeCount.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValue(1);
    await act(async () => root.render(<Count id="repo" />));
    await advance(200);
    await act(async () => gitEventService.emit('operation:completed', {
      repositoryPath: { workspaceId: 'repo' }, timestamp: new Date(), operationType: 'commit',
      description: 'Commit',
    }));
    await advance(200);
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst(8));
    expect(container.textContent).toBe('');
    await advance(200);
    expect(container.textContent).toBe('1');
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(2);
  });

  it('gates old peers and ignores a response from a previous device activation', async () => {
    let finishLocal!: (count: number) => void;
    mocks.getTrackedChangeCount.mockImplementationOnce(() => new Promise(resolve => { finishLocal = resolve; }))
      .mockResolvedValue(2);
    await act(async () => root.render(<Count id="same" />));
    await advance(200);
    await act(async () => activateSurface('peer'));
    await act(async () => finishLocal(99));
    await advance(200);
    expect(container.textContent).toBe('');
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(1);

    mocks.peer.mockReturnValue({ attachments: [{ deviceId: 'peer', health: 'ready',
      capabilities: { gitTrackedChangeCountV1: true, hostKind: 'cli' },
    }] });
    await act(async () => root.render(<Count id="same" remote />));
    await advance(200);
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Count id="same" />));
    await advance(200);
    expect(container.textContent).toBe('2');
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(2);
  });

  it('discards an old workspace result and refreshes an inactive workspace on return after a Git operation', async () => {
    let finishOld!: (count: number) => void;
    mocks.getTrackedChangeCount.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await act(async () => root.render(<Count id="old" />));
    await advance(200);
    await act(async () => root.render(<Count id="current" />));
    await advance(200);
    await act(async () => finishOld(99));
    expect(container.textContent).toBe('2');

    await act(async () => root.render(null));
    await act(async () => gitEventService.emit('operation:completed', {
      repositoryPath: { workspaceId: 'current' }, timestamp: new Date(), operationType: 'commit',
      description: 'Commit',
    }));
    await advance(200);
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Count id="current" />));
    await advance(200);
    expect(container.textContent).toBe('0');
    expect(mocks.getTrackedChangeCount).toHaveBeenCalledTimes(3);
  });
});
