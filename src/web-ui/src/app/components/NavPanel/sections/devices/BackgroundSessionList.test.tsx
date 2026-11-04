// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
const catalogState = vi.hoisted(() => ({ snapshot: { status: 'ready', sessions: {} as Record<string, unknown> } }));
vi.mock('@/infrastructure/peer-device/deviceWorkspaceCatalog', () => ({
  deviceWorkspaceCatalog: {
    getSnapshot: () => catalogState.snapshot,
    subscribe: () => () => undefined,
    loadMoreSessions: vi.fn(),
  },
}));
vi.mock('@/flow_chat/services/workspaceSessionTotals', async importOriginal => ({
  ...await importOriginal<typeof import('@/flow_chat/services/workspaceSessionTotals')>(),
  knownWorkspaceSessionTotal: () => 8,
}));

import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';
import { BackgroundSessionList } from './BackgroundSessionList';
import type { SidebarDeviceSlot } from './useSidebarDevices';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const slot: SidebarDeviceSlot = {
  surfaceId: 'peer-list', deviceId: 'peer-list', name: 'Studio', isLocal: false, rendered: false, hostKind: 'desktop', controllable: true,
};
const record = (sessionId: string, createdAt: number, lastFinishedAt: number) => ({
  sessionId, sessionName: sessionId, agentType: 'agentic', modelName: 'm', createdAt, lastActiveAt: lastFinishedAt,
  lastFinishedAt, turnCount: 1, messageCount: 1, toolCallCount: 0, status: 'active', tags: [], workspaceId: 'ws',
}) as never;

describe('BackgroundSessionList', () => {
  let host: HTMLDivElement;
  let root: Root;
  const actions = { pendingKey: null, run: vi.fn() };
  const rows = () => [...host.querySelectorAll('[data-testid="nav-device-session-item"]')].map(row => row.getAttribute('data-session-id'));
  const render = () => act(() => root.render(<BackgroundSessionList slot={slot} workspaceIds={['ws']} actions={actions} />));

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    flowChatStore.seedSurfaceSessions('peer-list', [{ workspaceId: 'ws', workspacePath: '/w', sessions: [
      record('oldest', 1, 100), record('newest-finished', 2, 900), record('middle', 3, 500),
      record('created-late', 9, 200), record('s5', 4, 300), record('s6', 5, 50),
    ] }]);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    flowChatStore.discardSurfaceState('peer-list');
    flowChatStore.discardSurfaceState('peer-empty');
    catalogState.snapshot = { status: 'ready', sessions: {} };
    useWorkspaceSessionViewStore.getState().setOrdering('updated');
  });

  it('orders by the live list rules and shows its first level', () => {
    useWorkspaceSessionViewStore.getState().setOrdering('updated');
    render();
    expect(rows()).toEqual(['newest-finished', 'middle', 's5']);
    const toggle = host.querySelector('[data-testid="nav-device-session-list-toggle"]');
    expect(toggle?.getAttribute('data-session-nav-toggle-action')).toBe('show-more');
    expect(toggle?.textContent).toContain('+5');
  });

  it('follows the ordering preference', () => {
    useWorkspaceSessionViewStore.getState().setOrdering('created');
    render();
    expect(rows()).toEqual(['created-late', 's6', 's5']);
  });

  it('expands like the live list', () => {
    render();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="nav-device-session-list-toggle"]')!.click());
    expect(rows()).toHaveLength(6);
  });

  it('limits a flat device list to three rows with show more', () => {
    act(() => root.render(<BackgroundSessionList slot={slot} workspaceIds={['ws']} actions={actions} flat />));
    expect(rows()).toHaveLength(3);
    expect(host.querySelector('[data-testid="nav-device-session-list-toggle"]')).not.toBeNull();
  });

  it('labels flat rows with their workspace like the live list', () => {
    act(() => root.render(<BackgroundSessionList slot={slot} workspaceIds={['ws']} actions={actions} flat
      workspaceNames={new Map([['ws', 'OpenBitFun']])} />));
    const names = [...host.querySelectorAll('.openbitfun-nav-panel__inline-item-workspace-name')].map(node => node.textContent);
    expect(names).toEqual(['OpenBitFun', 'OpenBitFun', 'OpenBitFun']);
  });

  describe('with no rows in the container', () => {
    const emptySlot = { ...slot, surfaceId: 'peer-empty', deviceId: 'peer-empty' };
    const renderEmpty = () => act(() => root.render(<BackgroundSessionList slot={emptySlot} workspaceIds={['ws']} actions={actions} />));
    const page = (sessions: unknown[]) => ({
      status: 'ready', sessions, records: sessions, activities: {}, hasMore: true, total: 8, limit: 8,
    });
    const empty = () => host.querySelector('.openbitfun-nav-panel__inline-empty');
    const loadingRow = () => host.querySelector('.openbitfun-nav-panel__inline-loading');
    const toggle = () => host.querySelector('[data-testid="nav-device-session-list-toggle"]');

    it('shows progress, not "no sessions" under a known total, while the rows the catalog lists are not drawn yet', () => {
      catalogState.snapshot = { status: 'ready', sessions: { ws: page([record('listed', 1, 1)]) } };
      renderEmpty();
      expect(empty()).toBeNull();
      expect(loadingRow()).not.toBeNull();
      expect(toggle()).toBeNull();
    });

    it('treats a workspace page not read yet as loading', () => {
      renderEmpty();
      expect(empty()).toBeNull();
      expect(loadingRow()).not.toBeNull();
    });

    it('says "no sessions" once the host listed none', () => {
      catalogState.snapshot = { status: 'ready', sessions: { ws: { ...page([]), hasMore: false, total: 0 } } };
      renderEmpty();
      expect(empty()).not.toBeNull();
      expect(loadingRow()).toBeNull();
    });
  });
});
