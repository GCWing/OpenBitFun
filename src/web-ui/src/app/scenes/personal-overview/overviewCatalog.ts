import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';

export interface CatalogPreview<T> {
  items: Array<{ item: T; updatedAt?: number }>;
  chronological: boolean;
  incomplete: boolean;
}

function validTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function latestCatalogItems<T>(items: CatalogPreview<T>['items']): CatalogPreview<T> {
  const normalized = items.map(entry => ({ ...entry, updatedAt: validTimestamp(entry.updatedAt) }));
  const dated = normalized.filter(entry => entry.updatedAt !== undefined);
  return {
    items: (dated.length > 0
      ? dated.sort((a, b) => b.updatedAt! - a.updatedAt!)
      : normalized).slice(0, 3),
    chronological: dated.length > 0,
    incomplete: dated.length < normalized.length,
  };
}

export function recentMiniApps(apps: MiniAppMeta[]): CatalogPreview<MiniAppMeta> {
  return latestCatalogItems(apps.map(item => ({
    item, updatedAt: validTimestamp(item.updated_at) ?? validTimestamp(item.created_at),
  })));
}
