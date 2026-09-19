import { productControlAPI, type ProductControlDiscoveryRequest } from '@/infrastructure/api/service-api/ProductControlAPI';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { controlRecord } from './openBitFunControlCardModel';

export class ControlDiscoveryError extends Error {
  constructor(readonly code: 'catalog-changed' | 'invalid-page') {
    super(`OpenBitFun discovery failed: ${code}`);
  }
}

/** Read the complete query from the same product host, without changing the recorded tool result. */
export async function loadAllOpenBitFunControlResults(
  request: ProductControlDiscoveryRequest,
  initialResult: Record<string, unknown>,
  scope: Pick<SurfaceScope, 'assertCurrent'>,
  signal: AbortSignal,
  readPage: (request: ProductControlDiscoveryRequest) => Promise<unknown> = request => productControlAPI.discover(request),
): Promise<Record<string, unknown>[]> {
  let digest = typeof initialResult.catalogDigest === 'string' ? initialResult.catalogDigest : undefined;
  let totalCount = typeof initialResult.totalCount === 'number'
    && Number.isSafeInteger(initialResult.totalCount) && initialResult.totalCount >= 0
    ? initialResult.totalCount : undefined;
  let cursor = 0;
  const items: Record<string, unknown>[] = [];
  const ids = new Set<string>();

  // Start at zero so a card recording a later page can still show the whole query.
  for (;;) {
    scope.assertCurrent('Read OpenBitFun discovery results');
    signal.throwIfAborted();
    const page = controlRecord(await readPage({ ...request, cursor }));
    scope.assertCurrent('Apply OpenBitFun discovery results');
    signal.throwIfAborted();
    if (digest !== undefined && page.catalogDigest !== digest) throw new ControlDiscoveryError('catalog-changed');
    if (typeof page.catalogDigest === 'string') digest = page.catalogDigest;
    if (!Array.isArray(page.items) || (page.cursor !== undefined && page.cursor !== cursor)) {
      throw new ControlDiscoveryError('invalid-page');
    }
    if (page.totalCount !== undefined) {
      if (!Number.isSafeInteger(page.totalCount) || (page.totalCount as number) < 0
        || totalCount !== undefined && page.totalCount !== totalCount) {
        throw new ControlDiscoveryError('invalid-page');
      }
      totalCount = page.totalCount as number;
    }
    for (const item of page.items) {
      const record = controlRecord(item);
      const id = record.capabilityId ?? record.id;
      if (typeof id !== 'string' || !id || ids.has(id)) throw new ControlDiscoveryError('invalid-page');
      ids.add(id);
      items.push(record);
    }
    if (page.nextCursor === undefined || page.nextCursor === null) {
      if (totalCount !== undefined && totalCount !== items.length) throw new ControlDiscoveryError('invalid-page');
      return items;
    }
    if (!Number.isSafeInteger(page.nextCursor) || (page.nextCursor as number) <= cursor || page.items.length === 0) {
      throw new ControlDiscoveryError('invalid-page');
    }
    cursor = page.nextCursor as number;
  }
}
