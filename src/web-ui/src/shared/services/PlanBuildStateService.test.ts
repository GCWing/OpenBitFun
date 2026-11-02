// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => new Map<string, (event: any) => void>());
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: Object.fromEntries(['Completed', 'Failed', 'Cancelled', 'Interrupted'].map(name => [
    `onDialogTurn${name}`, (callback: (event: any) => void) => { listeners.set(name, callback); return vi.fn(); },
  ])),
}));

import { planBuildStateService as service, type PlanFileRef } from './PlanBuildStateService';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { routeSurfaceEvent } from '@/infrastructure/peer-device/deviceSurfaceRouting';

const plan: PlanFileRef = { planFilePath: '/workspace/example.plan.md', workspaceId: 'workspace' };
afterEach(() => {
  for (const surface of ['local', 'peer']) {
    activateSurface(surface);
    service.cancelBuild(plan);
    service.cancelBuild({ ...plan, workspaceId: 'other' });
  }
  activateSurface('local');
});

describe('turn-owned plan builds without todos', () => {
  it.each(['Completed', 'Failed', 'Cancelled', 'Interrupted'])('settles only the owning turn on %s', name => {
    const card = vi.fn();
    const viewer = vi.fn();
    const offCard = service.subscribe(plan, card);
    const offViewer = service.subscribe(plan, viewer);
    const turnId = service.startBuild({ ...plan, sessionId: 'session' });
    const other = { ...plan, workspaceId: 'other' };
    service.startBuild({ ...other, sessionId: 'session' });
    expect(service.startBuild({ ...plan, sessionId: 'session' })).toBeNull();
    listeners.get(name)!({ sessionId: 'unrelated', turnId });
    listeners.get(name)!({ sessionId: 'session', turnId: 'previous-turn' });
    expect(service.getBuildStatus(plan)).toBe('building');
    listeners.get(name)!({ sessionId: 'session', turnId });
    const expected = name === 'Completed' ? 'built' : 'build';
    expect(service.getBuildStatus(plan)).toBe(expected);
    expect(service.getBuildStatus(other)).toBe('building');
    expect(card.mock.calls).toEqual([['building'], [expected]]);
    expect(viewer.mock.calls).toEqual(card.mock.calls);
    // Duplicate delivery cannot undo completion, including routed + API fan-out.
    listeners.get('Cancelled')!({ sessionId: 'session', turnId });
    expect(service.getBuildStatus(plan)).toBe(expected);
    offCard(); offViewer();
    expect(service.getBuildStatus(plan)).toBe(expected);
  });

  it('treats unsuccessful completion as retryable and ignores a late prior turn', () => {
    const turnId = service.startBuild({ ...plan, sessionId: 'session', turnId: 'draft-turn' });
    expect(turnId).toBe('draft-turn');
    listeners.get('Completed')!({ session_id: 'session', turn_id: turnId, success: false });
    expect(service.getBuildStatus(plan)).toBe('build');
    service.startBuild({ ...plan, sessionId: 'session' });
    listeners.get('Completed')!({ sessionId: 'session', turnId });
    expect(service.getBuildStatus(plan)).toBe('building');
    service.cancelBuild(plan);
    expect(service.getBuildStatus(plan)).toBe('build');
  });

  it('keeps equal workspace paths and turn IDs isolated across devices and settles background peers', () => {
    service.startBuild({ ...plan, sessionId: 'session', turnId: 'turn' });
    activateSurface('peer');
    expect(service.getBuildStatus(plan)).toBe('build');
    service.startBuild({ ...plan, sessionId: 'session', turnId: 'turn' });
    activateSurface('local');
    routeSurfaceEvent('agentic://dialog-turn-completed', {
      __openbitfunSourceDeviceId: 'peer', sessionId: 'session', turnId: 'turn', success: true,
    });
    expect(service.getBuildStatus(plan)).toBe('building');
    activateSurface('peer');
    expect(service.getBuildStatus(plan)).toBe('built');
  });
});
