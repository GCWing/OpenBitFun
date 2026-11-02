import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type {
  InstalledMarketOrigin,
  MarketListingSummary,
  MarketSort,
} from '@/infrastructure/api/service-api/MiniAppMarketAPI';

export type MiniAppLibraryAction = 'get' | 'open' | 'update';
export type MiniAppLibraryCatalog = 'installed' | 'market';

export interface MiniAppLibraryItem {
  key: string;
  action: MiniAppLibraryAction;
  app?: MiniAppMeta;
  downloadCount: number;
  listing?: MarketListingSummary;
  origin?: InstalledMarketOrigin;
  ratingAverage: number;
  ratingCount: number;
  sortPublishedAtMs: number;
}

const ACTION_PRIORITY: Record<MiniAppLibraryAction, number> = {
  update: 0,
  open: 1,
  get: 2,
};

export function selectMiniAppLibraryItems(
  items: MiniAppLibraryItem[],
  catalog: MiniAppLibraryCatalog,
): MiniAppLibraryItem[] {
  return items.filter((item) => catalog === 'installed' ? Boolean(item.app) : Boolean(item.listing));
}

/**
 * Projects the local catalog and the marketplace into one App Store-style
 * library. A marketplace origin is the durable join key: local app ids may
 * differ from listing ids and local version counters are not market releases.
 */
export function buildMiniAppLibraryItems(
  listings: MarketListingSummary[],
  apps: MiniAppMeta[],
  origins: Record<string, InstalledMarketOrigin>,
  sort: MarketSort = 'newest',
): MiniAppLibraryItem[] {
  const seenListingIds = new Set<string>();
  const uniqueListings = listings.filter((listing) => {
    if (seenListingIds.has(listing.listingId)) return false;
    seenListingIds.add(listing.listingId);
    return true;
  });
  const installedByListingId = new Map<
    string,
    { app: MiniAppMeta; origin: InstalledMarketOrigin }
  >();

  for (const app of apps) {
    const origin = origins[app.id];
    if (origin && !installedByListingId.has(origin.listingId)) {
      installedByListingId.set(origin.listingId, { app, origin });
    }
  }

  const consumedAppIds = new Set<string>();
  const projected: Array<{ item: MiniAppLibraryItem; order: number }> = uniqueListings.map((listing, index) => {
    const installed = installedByListingId.get(listing.listingId);
    if (installed) consumedAppIds.add(installed.app.id);

    const action: MiniAppLibraryAction = !installed
      ? 'get'
      : installed.origin.releaseNumber < listing.latestRelease
        ? 'update'
        : 'open';

    return {
      item: {
        key: `market:${listing.listingId}`,
        action,
        app: installed?.app,
        downloadCount: listing.downloadCount,
        listing,
        origin: installed?.origin,
        ratingAverage: listing.ratingAverage,
        ratingCount: listing.ratingCount,
        sortPublishedAtMs: listing.publishedAt * 1000,
      } satisfies MiniAppLibraryItem,
      order: index,
    };
  });

  for (const [index, app] of apps.entries()) {
    if (consumedAppIds.has(app.id)) continue;
    projected.push({
      item: {
        // Keep a marketplace install's DOM identity when metadata arrives.
        key: origins[app.id] && installedByListingId.get(origins[app.id].listingId)?.app.id === app.id
          ? `market:${origins[app.id].listingId}`
          : `local:${app.id}`,
        action: 'open',
        app,
        downloadCount: 0,
        origin: origins[app.id],
        ratingAverage: 3,
        ratingCount: 0,
        sortPublishedAtMs: app.created_at,
      },
      order: uniqueListings.length + index,
    });
  }

  return projected
    .sort((left, right) => compareLibraryItems(left, right, sort))
    .map(({ item }) => item);
}

function compareLibraryItems(
  left: { item: MiniAppLibraryItem; order: number },
  right: { item: MiniAppLibraryItem; order: number },
  sort: MarketSort,
): number {
  if (sort === 'downloads') {
    const byDownloads = right.item.downloadCount - left.item.downloadCount;
    if (byDownloads !== 0) return byDownloads;
  } else if (sort === 'rating') {
    const byRating = right.item.ratingAverage - left.item.ratingAverage;
    if (byRating !== 0) return byRating;
    const byRatingCount = right.item.ratingCount - left.item.ratingCount;
    if (byRatingCount !== 0) return byRatingCount;
  }

  const byPublishedAt = right.item.sortPublishedAtMs - left.item.sortPublishedAtMs;
  if (byPublishedAt !== 0) return byPublishedAt;

  return ACTION_PRIORITY[left.item.action] - ACTION_PRIORITY[right.item.action]
    || left.order - right.order;
}
