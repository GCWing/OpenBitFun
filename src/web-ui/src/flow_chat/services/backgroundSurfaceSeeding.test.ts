import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (surfaceId: string) => void;
const catalog = vi.hoisted(() => ({
  snapshots: new Map<string, unknown>(),
  listeners: new Set<(surfaceId: string) => void>(),
}));
vi.mock('@/infrastructure/peer-device/deviceWorkspaceCatalog', () => ({
  deviceWorkspaceCatalog: {
    getSnapshot: (surfaceId: string) => catalog.snapshots.get(surfaceId) ?? { status: 'idle', workspaces: [], sessions: {}, live: false },
    subscribe: (listener: Listener) => { catalog.listeners.add(listener); return () => { catalog.listeners.delete(listener); }; },
    loadedSurfaces: () => [...catalog.snapshots.keys()],
  },
}));

import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { installBackgroundSurfaceSeeding } from './backgroundSurfaceSeeding';
import { DEFAULT_SESSION_VIEW_KEY, forgetSurfaceSessionTotals, knownWorkspaceSessionTotal } from './workspaceSessionTotals';

const record = (sessionId: string, workspaceId: string, title = sessionId) => ({
  sessionId, sessionName: title, agentType: 'agentic', modelName: 'm', createdAt: 1, lastActiveAt: 1,
  turnCount: 1, messageCount: 1, toolCallCount: 0, status: 'active', tags: [], workspaceId,
}) as never;

function publish(surfaceId: string, pages: Record<string, unknown[]>) {
  catalog.snapshots.set(surfaceId, {
    status: 'ready', live: true,
    workspaces: Object.keys(pages).map(id => ({ id, name: id, rootPath: `/${id}`, workspaceKind: 'normal' })),
    sessions: Object.fromEntries(Object.entries(pages).map(([id, records]) => [id, {
      status: 'ready', sessions: records, records, activities: {}, hasMore: false, total: 8, limit: 8,
    }])),
  });
  for (const listener of [...catalog.listeners]) listener(surfaceId);
}

const ids = (surfaceId: string) => [...flowChatStore.getSurfaceSessions(surfaceId).keys()].sort();

describe('background surface seeding across a switch', () => {
  let uninstall: () => void;
  beforeEach(() => { uninstall = installBackgroundSurfaceSeeding(); });
  afterEach(() => {
    uninstall();
    if (getActiveSurfaceId() !== 'local') activateSurface('local');
    flowChatStore.discardSurfaceState('peer-seed');
    forgetSurfaceSessionTotals('peer-seed');
    catalog.snapshots.clear();
  });

  it('draws the sessions the catalog read while the device was rendered once it is left', () => {
    activateSurface('peer-seed');
    // The rendered device is kept warm: its pages land while it is rendered,
    // for workspaces its live list never read.
    publish('peer-seed', { repos: [record('r1', 'repos'), record('r2', 'repos')] });
    expect(ids('peer-seed')).toEqual([]);

    activateSurface('local');
    // No catalog read has landed since the switch, yet the rows are there.
    expect(ids('peer-seed')).toEqual(['r1', 'r2']);
    expect(knownWorkspaceSessionTotal('peer-seed', 'repos', DEFAULT_SESSION_VIEW_KEY)).toBe(8);
  });

  it('fills only what the container lacks; the catalog read after the switch refreshes the rest', () => {
    // Stand-in for what the live list loaded (renamed while rendered).
    flowChatStore.seedSurfaceSessions('peer-seed', [{ workspaceId: 'repos', workspacePath: '/repos', sessions: [record('r1', 'repos', 'new title')] }]);
    activateSurface('peer-seed');
    publish('peer-seed', { repos: [record('r1', 'repos', 'old title'), record('r2', 'repos')] });
    activateSurface('local');
    expect(ids('peer-seed')).toEqual(['r1', 'r2']);
    expect(flowChatStore.getSurfaceSessions('peer-seed').get('r1')?.title).toBe('new title');
    // The same older page notified again is not projected over it.
    for (const listener of [...catalog.listeners]) listener('peer-seed');
    expect(flowChatStore.getSurfaceSessions('peer-seed').get('r1')?.title).toBe('new title');
  });

  it('keeps directory rows when an explicit disconnect disposes the previously rendered container', () => {
    publish('peer-seed', { repos: [record('r1', 'repos'), record('r2', 'repos')] });
    activateSurface('peer-seed');
    activateSurface('local');
    flowChatStore.discardSurfaceState('peer-seed');
    // No new RPC or changed record array: the still-visible device catalog
    // owns these metadata rows independently of the disposed transcript.
    expect(ids('peer-seed')).toEqual(['r1', 'r2']);
    expect(flowChatStore.getSurfaceSessions('peer-seed').get('r1')?.historyState).toBe('metadata-only');
  });
});
