import { describe, expect, it, vi } from 'vitest';
import { runFederatedSearch } from './federatedSearchEngine';
import { buildGlobalSearchResultPresentation } from './globalSearchResultPresentation';
import type { GlobalSearchItem, GlobalSearchProvider, GlobalSearchRequest } from './types';

const request: GlobalSearchRequest = {
  rawQuery: 'search',
  query: 'search',
  scope: 'all',
  workspaces: [],
  currentWorkspace: null,
  limitPerGroup: 2,
  tCommon: (key) => key,
  tCapabilities: key => key,
  tSettings: (key) => key,
};

function provider(
  id: string,
  search: GlobalSearchProvider['search'],
): GlobalSearchProvider {
  return { id, groups: ['actions'], search };
}

describe('runFederatedSearch', () => {
  it('prioritizes app actions, settings, and features over higher-scoring history and files', async () => {
    const items: GlobalSearchItem[] = [
      {
        id: 'message', providerId: 'mixed', group: 'messages', title: 'Appearance notes', score: 100,
        target: { kind: 'session', sessionId: 'session', workspaceId: 'workspace', workspacePath: '/project' },
      },
      {
        id: 'file', providerId: 'mixed', group: 'files', title: 'appearance.md', score: 100,
        target: { kind: 'file', workspaceId: 'workspace', workspacePath: '/project', filePath: '/project/appearance.md', fileName: 'appearance.md' },
      },
      {
        id: 'feature', providerId: 'mixed', group: 'capabilities', title: 'Appearance features', score: 20,
        target: { kind: 'capability', capabilityId: 'feature.appearance' },
      },
      {
        id: 'setting', providerId: 'mixed', group: 'settings', title: 'Appearance settings', score: 20,
        target: { kind: 'capability', capabilityId: 'setting.appearance' },
      },
      {
        id: 'action', providerId: 'mixed', group: 'actions', title: 'Open settings', score: 20,
        target: { kind: 'action', actionId: 'settings.open' },
      },
    ];
    const result = await runFederatedSearch([{
      id: 'mixed', groups: ['messages', 'files', 'capabilities', 'settings', 'actions'],
      search: () => ({ items }),
    }], request, new AbortController().signal, () => {});

    const expectedOrder = ['action', 'setting', 'feature', 'message', 'file'];
    expect(result.items.map(item => item.id)).toEqual(expectedOrder);
    const presentation = buildGlobalSearchResultPresentation(result.items, {
      hasQuery: true,
      drilldownGroup: null,
    });
    expect(presentation.groups.map(group => group.items[0]?.id)).toEqual(expectedOrder);
    expect(presentation.navigableItems.map(item => item.id)).toEqual(expectedOrder);
  });

  it('keeps successful results when another provider fails', async () => {
    const updates = vi.fn();
    const result = await runFederatedSearch([
      provider('healthy', async () => ({
        items: [{
          id: 'action:healthy',
          providerId: 'healthy',
          group: 'actions',
          title: 'Healthy',
          score: 80,
          target: { kind: 'action', actionId: 'settings.open' },
        }],
      })),
      provider('broken', async () => {
        throw new Error('offline');
      }),
    ], request, new AbortController().signal, updates);

    expect(result.items.map((item) => item.id)).toEqual(['action:healthy']);
    expect(result.providerStatus).toEqual({ healthy: 'ready', broken: 'error' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ providerId: 'broken', code: 'provider_unavailable' }),
    ]);
    expect(updates).toHaveBeenCalled();
  });

  it('retries only the failed source while keeping successful results throughout', async () => {
    const healthy = provider('healthy', vi.fn(() => ({ items: [{
      id: 'healthy-result', providerId: 'healthy', group: 'actions', title: 'Healthy result', score: 80,
      target: { kind: 'action', actionId: 'settings.open' },
    }] })));
    const failed = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [] });
    const sources = [healthy, provider('broken', failed)];
    const previous = await runFederatedSearch(sources, request, new AbortController().signal, () => {});
    const updates = vi.fn();
    const result = await runFederatedSearch(sources, request, new AbortController().signal, updates,
      { previous, providerIds: ['broken'] });
    expect(healthy.search).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(updates.mock.calls.every(([value]) => value.items.some((item: { id: string }) => item.id === 'healthy-result'))).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.isSearching).toBe(false);
  });

  it('sorts deterministically, deduplicates by stable id, and enforces group budgets', async () => {
    const result = await runFederatedSearch([
      provider('first', () => ({
        items: [
          {
            id: 'action:a', providerId: 'first', group: 'actions', title: 'A', score: 20,
            target: { kind: 'action', actionId: 'settings.open' },
          },
          {
            id: 'action:b', providerId: 'first', group: 'actions', title: 'B', score: 90,
            target: { kind: 'action', actionId: 'settings.shortcuts.open' },
          },
          {
            id: 'action:c', providerId: 'first', group: 'actions', title: 'C', score: 80,
            target: { kind: 'action', actionId: 'surface.browser.open' },
          },
        ],
      })),
      provider('second', () => ({
        items: [{
          id: 'action:a', providerId: 'second', group: 'actions', title: 'A improved', score: 1000,
          target: { kind: 'action', actionId: 'settings.open' },
        }],
      })),
    ], request, new AbortController().signal, () => {});

    expect(result.items.map((item) => item.id)).toEqual(['action:a', 'action:b']);
    expect(result.items[0]?.score).toBe(100);
  });

  it('does not publish provider completions after cancellation', async () => {
    const controller = new AbortController();
    const updates = vi.fn();
    const delayed = provider('delayed', async () => {
      controller.abort();
      return { items: [] };
    });

    const result = await runFederatedSearch([delayed], request, controller.signal, updates);

    expect(updates).toHaveBeenCalledTimes(1);
    expect(result.isSearching).toBe(true);
  });

  it('treats cross-realm AbortError values as cancellation', async () => {
    const updates = vi.fn();
    const result = await runFederatedSearch([
      provider('cancelled', async () => {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }),
    ], request, new AbortController().signal, updates);

    expect(result.providerStatus.cancelled).toBe('ready');
    expect(result.isSearching).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(updates).toHaveBeenCalledTimes(2);
  });
});
