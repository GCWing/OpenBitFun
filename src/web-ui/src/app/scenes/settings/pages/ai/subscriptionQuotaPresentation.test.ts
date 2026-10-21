import { expect, it } from 'vitest';
import type { SubscriptionQuotaSnapshot } from '@/infrastructure/api/service-api/AIApi';
import { quotaIsStale, quotaMeters, remainingPercent } from './subscriptionQuotaPresentation';

it('reads legacy Codex windows and additional model meters without inventing amounts', () => {
  const snapshot: SubscriptionQuotaSnapshot = { account_id: 'codex', provider: 'codex', state: 'known', windows: [{ id: 'primary', used_percent: 25 }],
    details: { version: 1, buckets: [{ id: 'spark', display_name: 'Spark', windows: [{ id: 'primary', used_percent: 60 }] }] } };
  const meters = quotaMeters(snapshot);
  expect(meters.map(meter => meter.id)).toEqual(['primary', 'spark:primary']);
  expect(meters[0].remaining).toBeUndefined();
  expect(remainingPercent(meters[0])).toBe(75);
  expect(remainingPercent({ id: 'unknown' })).toBeUndefined();
  expect(remainingPercent({ id: 'unlimited', used_percent: 100, unlimited: true })).toBeUndefined();
});
it('refuses unsupported future views and marks old observations as stale', () => {
  const snapshot: SubscriptionQuotaSnapshot = { account_id: 'zcode', provider: 'zcode', state: 'known', windows: [], valid_until: 2000,
    display: { version: 99, meters: [{ id: 'future', remaining: 100 }] } };
  expect(quotaMeters(snapshot)).toEqual([]);
  expect(quotaIsStale(snapshot, false, 2000)).toBe(true);
  expect(quotaIsStale(snapshot, false, 1000)).toBe(false);
  expect(quotaIsStale(snapshot, true, 1000)).toBe(true);
});
