import { describe, expect, it, vi } from 'vitest';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { loadWorkspaceSessionSourcePages } from './workspaceSessionSourcePages';

const page = (hasMore: boolean, nextCursor?: string): SessionMetadataPage => ({
  sessions: [], totalTopLevelCount: 107, loadedTopLevelCount: 50, hasMore, nextCursor,
});

describe('complete session metadata traversal for source filters', () => {
  it('traverses all pages and preserves nonfatal discovery notices', async () => {
    const load = vi.fn().mockResolvedValueOnce({ ...page(true, '50'), discoveryWarnings: ['partial'] })
      .mockResolvedValueOnce(page(true, '100')).mockResolvedValueOnce(page(false));
    expect(await loadWorkspaceSessionSourcePages(load, () => true)).toEqual(['partial']);
    expect(load.mock.calls).toEqual([[undefined], ['50'], ['100']]);
  });

  it('does not issue another read after the source scope or serving device changes', async () => {
    let current = true;
    const load = vi.fn(async () => { current = false; return page(true, '50'); });
    await loadWorkspaceSessionSourcePages(load, () => current);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'repeated'])('reports a nonadvancing cursor (%s) instead of looping or pretending completion', async cursor => {
    const load = vi.fn().mockResolvedValue(page(true, cursor));
    await expect(loadWorkspaceSessionSourcePages(load, () => true)).rejects.toThrow('did not advance');
    expect(load).toHaveBeenCalledTimes(cursor ? 2 : 1);
  });

  it('keeps read failures observable so the list can offer a retry', async () => {
    const load = vi.fn().mockResolvedValueOnce(page(true, '50')).mockRejectedValueOnce(new Error('Disconnected'));
    await expect(loadWorkspaceSessionSourcePages(load, () => true)).rejects.toThrow('Disconnected');
  });
});
