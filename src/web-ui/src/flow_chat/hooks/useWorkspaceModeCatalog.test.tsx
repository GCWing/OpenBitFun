/**
 * @vitest-environment jsdom
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModeInfo } from '../reducers/modeReducer';
import { useWorkspaceModeCatalog } from './useWorkspaceModeCatalog';

const mocks = vi.hoisted(() => ({
  getAvailableModes: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { getAvailableModes: mocks.getAvailableModes },
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { on: mocks.on, off: mocks.off },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function mode(id: string): ModeInfo {
  return {
    id,
    name: id,
    description: id,
    isReadonly: false,
    toolCount: 0,
    promptCacheScopeKey: id,
    source: 'external',
  };
}

function Probe({ workspaceId }: { workspaceId: string }) {
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const refresh = useWorkspaceModeCatalog({ workspaceId }, setModes);
  return (
    <>
      <button type="button" onClick={() => void refresh()}>Refresh</button>
      <div data-testid="catalog">{modes.map(entry => entry.id).join(',')}</div>
    </>
  );
}

describe('useWorkspaceModeCatalog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('never publishes a late catalog from the previous workspace', async () => {
    const workspaceA = deferred<ModeInfo[]>();
    const workspaceB = deferred<ModeInfo[]>();
    mocks.getAvailableModes.mockImplementation((request?: { workspaceId?: string }) => (
      request?.workspaceId === 'workspace-A' ? workspaceA.promise : workspaceB.promise
    ));

    await act(async () => {
      root.render(<Probe workspaceId="workspace-A" />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Probe workspaceId="workspace-B" />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="catalog"]')?.textContent).toBe('');

    await act(async () => {
      workspaceB.resolve([mode('workspace-b')]);
      await workspaceB.promise;
    });
    expect(container.querySelector('[data-testid="catalog"]')?.textContent).toBe('workspace-b');

    await act(async () => {
      workspaceA.resolve([mode('workspace-a')]);
      await workspaceA.promise;
    });
    expect(container.querySelector('[data-testid="catalog"]')?.textContent).toBe('workspace-b');
  });

  it('refreshes on demand and keeps the newest same-workspace result', async () => {
    const initial = deferred<ModeInfo[]>();
    const refreshed = deferred<ModeInfo[]>();
    mocks.getAvailableModes
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      root.render(<Probe workspaceId="workspace-A" />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      refreshed.resolve([mode('refreshed')]);
      await refreshed.promise;
    });
    expect(container.querySelector('[data-testid="catalog"]')?.textContent).toBe('refreshed');

    await act(async () => {
      initial.resolve([mode('stale')]);
      await initial.promise;
    });
    expect(container.querySelector('[data-testid="catalog"]')?.textContent).toBe('refreshed');
  });
});
