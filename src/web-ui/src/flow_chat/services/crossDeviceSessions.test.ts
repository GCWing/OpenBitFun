// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => ({
  snapshots: {} as Record<string, unknown>,
  surfaces: [] as string[],
}));
vi.mock('@/infrastructure/peer-device/deviceWorkspaceCatalog', () => ({
  deviceWorkspaceCatalog: {
    getSnapshot: (surfaceId: string) => catalog.snapshots[surfaceId] ?? { workspaces: [], sessions: {} },
    loadedSurfaces: () => catalog.surfaces,
    subscribe: () => () => undefined,
  },
}));

import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { sessionActivityStore } from '../store/sessionActivityStore';
import { listBackgroundDeviceSessions, listCrossDeviceSessions } from './crossDeviceSessions';

const summary = (sessionId: string, execution: string) => ({ sessionId, execution, pendingApprovals: 0, pendingQuestions: 0 });

describe('crossDeviceSessions', () => {
  afterEach(() => {
    catalog.snapshots = {};
    catalog.surfaces = [];
    resetDeviceSurfaceForTest();
  });

  it('prefers the host summary over observed events, which only fill gaps', () => {
    sessionActivityStore.applyRead(sessionActivityStore.beginRead('peer-a'), [summary('s-1', 'running'), summary('s-2', 'running')]);
    catalog.snapshots['peer-a'] = {
      workspaces: [{ id: 'ws-1' }],
      sessions: { 'ws-1': { sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }], activities: { 's-1': summary('s-1', 'idle') } } },
    };
    const rows = listCrossDeviceSessions('peer-a');
    expect(rows.map(row => [row.session.sessionId, row.activity?.execution])).toEqual([['s-1', 'idle'], ['s-2', 'running']]);
  });

  it('lists every loaded device except the rendered one', () => {
    catalog.surfaces = ['local', 'peer-a'];
    catalog.snapshots['local'] = { workspaces: [{ id: 'w' }], sessions: { w: { sessions: [{ sessionId: 'l-1' }], activities: {} } } };
    catalog.snapshots['peer-a'] = { workspaces: [{ id: 'w' }], sessions: { w: { sessions: [{ sessionId: 'p-1' }], activities: {} } } };
    activateSurface('peer-a');
    expect(listBackgroundDeviceSessions().map(row => row.session.sessionId)).toEqual(['l-1']);
  });
});
