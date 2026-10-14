import { describe, expect, it } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { latestCatalogItems, recentMiniApps } from './overviewCatalog';

describe('home catalog previews', () => {
  it('shows the three latest known dates without mutating catalog order or treating unknown dates as new', () => {
    const entries = [
      { item: 'unknown' }, { item: 'old', updatedAt: 1 }, { item: 'new', updatedAt: 5 },
      { item: 'middle', updatedAt: 3 }, { item: 'equal', updatedAt: 3 }, { item: 'invalid', updatedAt: NaN },
    ];
    const preview = latestCatalogItems(entries);
    expect(preview.items.map(entry => entry.item)).toEqual(['new', 'middle', 'equal']);
    expect(preview).toMatchObject({ chronological: true, incomplete: true });
    expect(entries[0].item).toBe('unknown');
  });

  it('uses creation time for a MiniApp without a valid update time', () => {
    const apps = [
      { id: 'created', created_at: 20, updated_at: 0 },
      { id: 'updated', created_at: 1, updated_at: 30 },
    ] as MiniAppMeta[];
    expect(recentMiniApps(apps).items.map(({ item }) => item.id)).toEqual(['updated', 'created']);
  });
});
