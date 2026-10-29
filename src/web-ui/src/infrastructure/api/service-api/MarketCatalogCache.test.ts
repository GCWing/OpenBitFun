// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniAppMarketAPI, type MarketListingSummary } from './MiniAppMarketAPI';
import { resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { readMarketCatalog, writeMarketCatalog } from './MarketCatalogCache';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./ApiClient', () => ({ api: mocks }));

const listing: MarketListingSummary = {
  listingId: 'one', slug: 'one', name: 'One', description: '', icon: 'box',
  category: 'utilities', tags: [], permissions: {},
  owner: { githubId: 1, login: 'owner', avatarUrl: '' },
  latestRelease: 1, minOpenBitFunVersion: '1.0.0', publishedAt: 1,
  screenshotUrls: [`https://market.test/screenshots/${'a'.repeat(64)}`],
  ratingAverage: 4, ratingCount: 2, downloadCount: 12, favoriteCount: 3,
  isFavorited: true, myRating: 5,
};
describe('public marketplace catalog snapshots', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    mocks.invoke.mockReset();
    resetDeviceSurfaceForTest();
  });

  it('restores first-page ordering in a new API instance without retaining personal state', async () => {
    const request = { sort: 'downloads' as const, limit: 30 };
    const page = { items: [listing, { ...listing, listingId: 'two' }], nextCursor: 'next' };
    mocks.invoke.mockResolvedValue(page);
    await new MiniAppMarketAPI().browse(request);
    const cached = new MiniAppMarketAPI().getCachedPage(request);
    expect(cached?.items.map(item => item.listingId)).toEqual(['one', 'two']);
    expect(cached?.nextCursor).toBe('next');
    expect(cached?.items[0]).not.toHaveProperty('isFavorited');
    expect(cached?.items[0]).not.toHaveProperty('myRating');
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it('updates the cached image address when the server publishes a new content hash', async () => {
    const api = new MiniAppMarketAPI();
    mocks.invoke.mockResolvedValueOnce({ items: [listing] });
    await api.browse({});
    const replacement = { ...listing, screenshotUrls: [listing.screenshotUrls[0].replace('a'.repeat(64), 'c'.repeat(64))] };
    mocks.invoke.mockResolvedValueOnce({ items: [replacement] });
    await api.browse({});
    expect(new MiniAppMarketAPI().getCachedPage({})?.items[0].screenshotUrls)
      .toEqual(replacement.screenshotUrls);
  });

  it('isolates MiniApp snapshots by device, filter and sort', async () => {
    mocks.invoke.mockResolvedValue({ items: [listing] });
    const miniapps = new MiniAppMarketAPI();
    await miniapps.browse({ sort: 'downloads' });
    expect(miniapps.getCachedPage({ sort: 'rating' })).toBeUndefined();
    expect(miniapps.getCachedPage({ sort: 'downloads', category: 'data' })).toBeUndefined();
  });

  it('keeps the last successful page on a network failure and never replaces it with pagination', async () => {
    const api = new MiniAppMarketAPI();
    mocks.invoke.mockResolvedValueOnce({ items: [listing], nextCursor: 'next' });
    await api.browse({});
    mocks.invoke.mockResolvedValueOnce({ items: [{ ...listing, listingId: 'two' }] });
    await api.browse({ cursor: 'next' });
    expect(api.getCachedPage({})?.items.map(item => item.listingId)).toEqual(['one']);
    mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    await expect(api.browse({})).rejects.toThrow();
    expect(api.getCachedPage({})?.items[0].listingId).toBe('one');
  });

  it('tolerates absent, malformed, future and expired records without deleting them', () => {
    const key = 'openbitfun:market-catalog:v1';
    const valid = (value: unknown): value is number => typeof value === 'number';
    expect(readMarketCatalog('test', valid)).toBeUndefined();
    for (const raw of ['broken', JSON.stringify({ version: 9, pages: [] }), JSON.stringify({
      version: 1, pages: [{ key: 'test', savedAt: 1, page: { items: [1] } }],
    })]) {
      localStorage.setItem(key, raw);
      expect(readMarketCatalog('test', valid)).toBeUndefined();
      expect(localStorage.getItem(key)).toBe(raw);
    }
    writeMarketCatalog('test', { items: [1], nextCursor: 'next' });
    expect(readMarketCatalog('test', valid)).toEqual({ items: [1], nextCursor: 'next' });
  });
});
