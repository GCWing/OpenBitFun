import { describe, expect, it } from 'vitest';
import { loadAllOpenBitFunControlResults } from './openBitFunControlDiscovery';
import type { ProductControlDiscoveryRequest } from '@/infrastructure/api/service-api/ProductControlAPI';

const scope = { assertCurrent() {} };
const signal = () => new AbortController().signal;

describe('complete OpenBitFun discovery reads', () => {
  it('loads all 46 matches from a recorded 20-item page, preserving the query and history', async () => {
    const all = Array.from({ length: 46 }, (_, index) => ({ capabilityId: `feature.${index}`, titleEn: `Feature ${index}` }));
    const original = { items: all.slice(20, 40), cursor: 20, totalCount: 46, nextCursor: 40, catalogDigest: 'peer-catalog' };
    const before = JSON.stringify(original);
    const requests: ProductControlDiscoveryRequest[] = [];
    const loaded = await loadAllOpenBitFunControlResults({ action: 'search', query: 'appearance' }, original, scope, signal(), async request => {
      requests.push(request);
      const cursor = request.cursor!;
      return { catalogDigest: 'peer-catalog', cursor, items: all.slice(cursor, cursor + 20), totalCount: 46,
        nextCursor: cursor + 20 < 46 ? cursor + 20 : null };
    });
    expect(loaded).toEqual(all);
    expect(requests).toEqual([0, 20, 40].map(cursor => ({ action: 'search', query: 'appearance', cursor })));
    expect(JSON.stringify(original)).toBe(before);
  });

  it('accepts legacy id aliases and absent optional metadata', async () => {
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, {}, scope, signal(), async () => ({
      items: [{ id: 'feature.legacy' }], futureField: true,
    }))).resolves.toEqual([{ id: 'feature.legacy' }]);
  });

  it('retains the recorded total when a response omits optional pagination metadata', async () => {
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, { totalCount: 46 }, scope, signal(), async () => ({
      items: [{ id: 'first' }],
    }))).rejects.toMatchObject({ code: 'invalid-page' });
  });

  it('refuses to mix catalogs when the host version changes between pages', async () => {
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, { catalogDigest: 'original' }, scope, signal(), async request => ({
      catalogDigest: request.cursor === 0 ? 'original' : 'updated', cursor: request.cursor,
      items: [{ id: `feature.${request.cursor}` }], totalCount: 2, nextCursor: request.cursor === 0 ? 1 : null,
    }))).rejects.toMatchObject({ code: 'catalog-changed' });
  });

  it.each([
    { items: [{ id: 'first' }], cursor: 0, nextCursor: 0 },
    { items: [{ id: 'first' }], totalCount: 46 },
    { items: [{ id: 'first' }, { id: 'first' }] },
    { items: null },
  ])('rejects incomplete or non-progressing pages rather than reporting a complete list', async page => {
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, {}, scope, signal(), async () => page))
      .rejects.toMatchObject({ code: 'invalid-page' });
  });

  it('stops before the next read if the card is closed or its device surface changes', async () => {
    const controller = new AbortController();
    let reads = 0;
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, {}, scope, controller.signal, async () => {
      reads++;
      controller.abort();
      return { items: [{ id: 'first' }], nextCursor: 1 };
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);

    let current = true;
    await expect(loadAllOpenBitFunControlResults({ action: 'list' }, {}, {
      assertCurrent() { if (!current) throw new Error('Device changed'); },
    }, signal(), async () => {
      current = false;
      return { items: [{ id: 'first' }], nextCursor: 1 };
    })).rejects.toThrow('Device changed');
  });
});
