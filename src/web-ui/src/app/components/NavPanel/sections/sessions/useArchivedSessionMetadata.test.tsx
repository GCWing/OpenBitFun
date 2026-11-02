// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { loadArchivedSessionMetadata: mocks.load } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { useArchivedSessionMetadata } from './useArchivedSessionMetadata';

type Props = Parameters<typeof useArchivedSessionMetadata>[0];
let current: ReturnType<typeof useArchivedSessionMetadata>;
function Harness(props: Props) {
  current = useArchivedSessionMetadata(props);
  return null;
}
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('archived navigation metadata', () => {
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetDeviceSurfaceForTest();
    mocks.load.mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  const render = async (props: Partial<Props> = {}) => {
    await act(async () => root.render(<Harness workspaceIds={['main']} enabled refreshVersion={0} {...props} />));
  };

  it('loads grouped and aggregate workspace archives only when requested', async () => {
    await render({ enabled: false });
    expect(mocks.load).not.toHaveBeenCalled();
    await render();
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith('main');
    expect(current).toMatchObject({ loading: false, failed: false });
    await render();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await render({ workspaceIds: ['main', 'ssh-workspace'] });
    expect(mocks.load.mock.calls.map(([id]) => id)).toEqual(['main', 'main', 'ssh-workspace']);
    expect(current).toMatchObject({ loading: false, failed: false });
  });

  it('reports a partial archive failure and reloads the requested scopes on retry', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Host offline'));
    await render({ workspaceIds: ['main', 'remote'] });
    expect(current).toMatchObject({ loading: false, failed: true });
    await render({ workspaceIds: ['main', 'remote'], refreshVersion: 1 });
    expect(mocks.load).toHaveBeenCalledTimes(4);
    expect(current).toMatchObject({ loading: false, failed: false });
  });

  it('does not let a departed host complete the same workspace on the selected peer', async () => {
    const local = deferred();
    const peer = deferred();
    mocks.load.mockReturnValueOnce(local.promise).mockReturnValueOnce(peer.promise);
    await render();
    activateSurface('peer-one');
    await render();
    await act(async () => local.resolve());
    expect(current).toMatchObject({ loading: true, failed: false });
    expect(mocks.load).toHaveBeenCalledTimes(2);
    await act(async () => peer.resolve());
    expect(current).toMatchObject({ loading: false, failed: false });
  });

  it('ignores late failures after returning to the working list', async () => {
    const pending = deferred();
    mocks.load.mockReturnValueOnce(pending.promise);
    await render();
    await render({ enabled: false });
    await act(async () => pending.reject(new Error('Disconnected')));
    expect(current).toEqual({ loading: false, failed: false });
    await render();
    expect(current).toMatchObject({ loading: false, failed: false });
  });
});
