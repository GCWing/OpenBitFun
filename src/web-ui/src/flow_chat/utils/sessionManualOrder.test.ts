// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSessionOrdering } from '@/app/components/NavPanel/workspaceSessionView';
import {
  manualOrderScopeKey,
  moveSessionInOrder,
  orderSessionsManually,
  reconcileManualOrder,
} from './sessionManualOrder';
import type { SessionOrderingMode } from './sessionManualOrder';

const STORAGE_KEY = 'openbitfun.workspace-session-view.v2';

type SessionViewPreferencesModule = typeof import('@/app/components/NavPanel/workspaceSessionView');

/** Reloads the preference module as a fresh launch would, with an optional stored blob. */
async function loadPreferences(storedBlob?: string): Promise<SessionViewPreferencesModule> {
  vi.resetModules();
  window.localStorage.clear();
  if (storedBlob !== undefined) window.localStorage.setItem(STORAGE_KEY, storedBlob);
  return import('@/app/components/NavPanel/workspaceSessionView');
}

const itemIds = <T,>(items: readonly T[], idOf: (item: T) => string): string[] => items.map(idOf);

describe('manual session order', () => {
  it('files the aggregate list under a different scope than each workspace', () => {
    expect(manualOrderScopeKey({ workspaceId: 'ws-1' })).toBe('workspace:ws-1');
    expect(manualOrderScopeKey({ workspaceId: null })).toBe('all');
    expect(manualOrderScopeKey({ workspaceId: '' })).toBe('all');
    expect(manualOrderScopeKey({})).toBe('all');
  });

  it('clamps a move to both ends of the list', () => {
    const order = ['a', 'b', 'c'];

    expect(moveSessionInOrder(order, 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(moveSessionInOrder(order, 'c', -5)).toEqual(['c', 'a', 'b']);
    expect(moveSessionInOrder(order, 'b', 0)).toEqual(['b', 'a', 'c']);
    expect(moveSessionInOrder(order, 'b', 2)).toEqual(['a', 'c', 'b']);
  });

  it('inserts an unknown id at the clamped index instead of dropping it', () => {
    expect(moveSessionInOrder(['a', 'b'], 'new', 1)).toEqual(['a', 'new', 'b']);
    expect(moveSessionInOrder(['a', 'b'], 'new', 9)).toEqual(['a', 'b', 'new']);
    expect(moveSessionInOrder(['a', 'b'], 'new', -2)).toEqual(['new', 'a', 'b']);
  });

  it('de-duplicates stored ids and never mutates the array it was given', () => {
    const order = Object.freeze(['a', 'b', 'a', 'c']);
    const moved = moveSessionInOrder(order, 'b', 0);

    expect(moved).toEqual(['b', 'a', 'c']);
    expect(moved).not.toBe(order);
    expect(order).toEqual(['a', 'b', 'a', 'c']);
    expect(moveSessionInOrder(order, 'c', 1)).toEqual(['a', 'c', 'b']);
  });

  it('reconciles away deleted sessions while keeping the relative order', () => {
    expect(reconcileManualOrder(['a', 'b', 'a', 'c', 'd'], ['c', 'd', 'a'])).toEqual(['a', 'c', 'd']);
    expect(reconcileManualOrder(['a', 'b'], [])).toEqual([]);
    expect(reconcileManualOrder([], ['a'])).toEqual([]);
  });

  it('keeps sessions missing from the order on top in their incoming order', () => {
    const items = [
      { sessionId: 'a' },
      { sessionId: 'newest' },
      { sessionId: 'b' },
      { sessionId: 'newer' },
      { sessionId: 'c' },
    ];
    const idOf = (item: { sessionId: string }) => item.sessionId;

    expect(itemIds(orderSessionsManually(items, ['c', 'a', 'b'], idOf), idOf))
      .toEqual(['newest', 'newer', 'c', 'a', 'b']);
    expect(itemIds(items, idOf)).toEqual(['a', 'newest', 'b', 'newer', 'c']);
  });

  it('skips ordered ids no item matches and ignores duplicates in the order', () => {
    const items = [{ sessionId: 'a' }, { sessionId: 'b' }];
    const idOf = (item: { sessionId: string }) => item.sessionId;

    const ordered = orderSessionsManually(items, ['gone', 'b', 'b', 'a'], idOf);
    expect(itemIds(ordered, idOf)).toEqual(['b', 'a']);
    expect(ordered).not.toBe(items);
    expect(itemIds(items, idOf)).toEqual(['a', 'b']);
  });

  it('returns the incoming order when nothing was ordered yet', () => {
    const items = [{ sessionId: 'a' }, { sessionId: 'b' }];
    const idOf = (item: { sessionId: string }) => item.sessionId;

    expect(itemIds(orderSessionsManually(items, [], idOf), idOf)).toEqual(['a', 'b']);
  });

  it('keeps every navigation ordering mode inside the frozen ordering contract', () => {
    const navOrderingModes: WorkspaceSessionOrdering[] = [
      'updated',
      'status',
      'created',
      'name',
      'manual',
    ];
    const frozenModes: SessionOrderingMode[] = navOrderingModes;

    expect(frozenModes).toEqual(['updated', 'status', 'created', 'name', 'manual']);
  });
});

describe('manual order persistence', () => {
  let preferences: SessionViewPreferencesModule;

  beforeEach(async () => {
    preferences = await loadPreferences();
  });

  afterEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it('reads an empty order until the user reorders a scope', () => {
    expect(preferences.readManualOrder('all')).toEqual([]);
    expect(preferences.readManualOrder('workspace:ws-1')).toEqual([]);
    expect(preferences.useWorkspaceSessionViewStore.getState().manualOrder).toEqual({});
  });

  it('stores the order with the rest of the session view preferences', () => {
    preferences.writeManualOrder('workspace:ws-1', ['s2', 's1']);

    expect(preferences.readManualOrder('workspace:ws-1')).toEqual(['s2', 's1']);
    expect(preferences.readManualOrder('all')).toEqual([]);
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    expect(persisted.state.manualOrder).toEqual({ 'workspace:ws-1': ['s2', 's1'] });
  });

  it('restores the stored order on the next launch', async () => {
    preferences.writeManualOrder('all', ['s3', 's1']);
    const blob = window.localStorage.getItem(STORAGE_KEY) ?? undefined;

    const reloaded = await loadPreferences(blob);

    expect(reloaded.readManualOrder('all')).toEqual(['s3', 's1']);
  });

  it('sanitizes blank, duplicate and non-string ids on write', () => {
    preferences.writeManualOrder('all', ['a', 'a', '', 'b', 7 as unknown as string]);

    expect(preferences.readManualOrder('all')).toEqual(['a', 'b']);
  });

  it('drops a scope whose order became empty', () => {
    preferences.writeManualOrder('all', ['a']);
    preferences.writeManualOrder('all', reconcileManualOrder(['a'], []));

    expect(preferences.readManualOrder('all')).toEqual([]);
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    expect(persisted.state.manualOrder).toEqual({});
  });

  it('keeps the stored map when a repeated write changes nothing', () => {
    const store = preferences.useWorkspaceSessionViewStore;
    preferences.writeManualOrder('all', ['a', 'b']);
    const firstWrite = store.getState().manualOrder;

    preferences.writeManualOrder('all', ['b', 'a']);
    const secondWrite = store.getState().manualOrder;
    expect(secondWrite).not.toBe(firstWrite);
    expect(secondWrite).toEqual({ all: ['b', 'a'] });

    preferences.writeManualOrder('all', ['b', 'a']);
    expect(store.getState().manualOrder).toBe(secondWrite);
  });

  it('tolerates corrupted or legacy storage without throwing', async () => {
    const cases: [string, string[]][] = [
      ['{not json', []],
      [JSON.stringify({ state: { manualOrder: { all: 's1' } }, version: 3 }), []],
      [JSON.stringify({ state: { manualOrder: { all: [1, 2, null] } }, version: 3 }), []],
      [JSON.stringify({ state: { manualOrder: { all: ['s1', 2, 's1', null, 's2'] } }, version: 3 }), ['s1', 's2']],
      [JSON.stringify({ state: { manualOrder: [] }, version: 3 }), []],
      [JSON.stringify({ state: null, version: 1 }), []],
      [JSON.stringify({ state: 'broken', version: 2 }), []],
    ];

    for (const [blob, expected] of cases) {
      const module = await loadPreferences(blob);

      expect(module.readManualOrder('all')).toEqual(expected);
      expect(module.useWorkspaceSessionViewStore.getState().manualOrder)
        .toEqual(expected.length > 0 ? { all: expected } : {});
    }
  });

  it('accepts manual as a persisted ordering and falls back for unknown values', async () => {
    const manualMode = await loadPreferences(JSON.stringify({ state: { ordering: 'manual' }, version: 3 }));
    expect(manualMode.useWorkspaceSessionViewStore.getState().ordering).toBe('manual');

    const legacyMode = await loadPreferences(JSON.stringify({ state: { ordering: 'workspace', grouping: 'workspace' }, version: 1 }));
    expect(legacyMode.useWorkspaceSessionViewStore.getState().ordering).toBe('updated');
    expect(legacyMode.useWorkspaceSessionViewStore.getState().grouping).toBe('grouped');
  });
});
