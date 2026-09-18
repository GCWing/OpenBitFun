import { describe, expect, it, vi } from 'vitest';
import type { SceneTab } from '@/app/components/SceneBar/types';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import {
  getMiniAppIdFromSceneId,
  getMiniAppSceneId,
  projectMiniAppActivity,
  stopMiniAppActivity,
} from './miniAppActivity';

function app(id: string): MiniAppMeta {
  return {
    id,
    name: id,
    description: '',
    icon: 'box',
    category: 'test',
    tags: [],
    version: 1,
    created_at: 1,
    updated_at: 1,
    permissions: { node: { enabled: false } },
  };
}

function tab(id: SceneTab['id'], lastUsed: number): SceneTab {
  return { id, lastUsed };
}

describe('MiniApp activity projection', () => {
  it('treats an open Runner scene as active without requiring a worker', () => {
    const result = projectMiniAppActivity(
      [app('scene-only')],
      [tab('miniapp:scene-only', 1)],
      [],
    );

    expect(result).toEqual([{
      app: app('scene-only'),
      runnerMounted: true,
      workerRunning: false,
    }]);
  });

  it('includes worker-only apps and merges both sources without duplicates', () => {
    const result = projectMiniAppActivity(
      [app('both'), app('worker-only')],
      [tab('miniapp:both', 1)],
      ['both', 'worker-only', 'worker-only'],
    );

    expect(result.map(({ app: item, runnerMounted, workerRunning }) => ({
      id: item.id,
      runnerMounted,
      workerRunning,
    }))).toEqual([
      { id: 'both', runnerMounted: true, workerRunning: true },
      { id: 'worker-only', runnerMounted: false, workerRunning: true },
    ]);
  });

  it('ignores non-MiniApp scenes and app ids absent from the catalog', () => {
    expect(projectMiniAppActivity(
      [app('known')],
      [tab('settings', 1), tab('miniapp:missing', 2)],
      ['missing'],
    )).toEqual([]);
  });

  it('round-trips MiniApp scene ids', () => {
    expect(getMiniAppSceneId('ppt-live')).toBe('miniapp:ppt-live');
    expect(getMiniAppIdFromSceneId('miniapp:ppt-live')).toBe('ppt-live');
    expect(getMiniAppIdFromSceneId('miniapps')).toBeNull();
  });

  it('closes a scene-only MiniApp without invoking the worker runtime', async () => {
    const stopWorker = vi.fn(() => Promise.resolve());
    const markWorkerStopped = vi.fn();
    const closeScene = vi.fn();

    await stopMiniAppActivity({
      app: app('scene-only'),
      runnerMounted: true,
      workerRunning: false,
    }, { stopWorker, markWorkerStopped, closeScene });

    expect(stopWorker).not.toHaveBeenCalled();
    expect(markWorkerStopped).not.toHaveBeenCalled();
    expect(closeScene).toHaveBeenCalledWith('miniapp:scene-only');
  });

  it('does not fake success when stopping a worker fails', async () => {
    const failure = new Error('peer unavailable');
    const stopWorker = vi.fn(() => Promise.reject(failure));
    const markWorkerStopped = vi.fn();
    const closeScene = vi.fn();

    await expect(stopMiniAppActivity({
      app: app('both'),
      runnerMounted: false,
      workerRunning: true,
    }, { stopWorker, markWorkerStopped, closeScene })).rejects.toBe(failure);

    expect(markWorkerStopped).not.toHaveBeenCalled();
    expect(closeScene).not.toHaveBeenCalled();
  });

  it('delegates mounted apps to the scene shutdown gate and awaits its completion', async () => {
    const calls: string[] = [];

    await stopMiniAppActivity({
      app: app('both'),
      runnerMounted: true,
      workerRunning: true,
    }, {
      stopWorker: async () => { calls.push('stop-worker'); },
      markWorkerStopped: () => { calls.push('mark-worker-stopped'); },
      closeScene: async () => { await Promise.resolve(); calls.push('close-scene'); },
    });

    expect(calls).toEqual(['close-scene']);
  });
});
