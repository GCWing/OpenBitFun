import type { SubscriptionQuotaMeter, SubscriptionQuotaSnapshot } from '@/infrastructure/api/service-api/AIApi';

export function quotaMeters(snapshot: SubscriptionQuotaSnapshot | null): SubscriptionQuotaMeter[] {
  if (!snapshot || snapshot.state === 'unsupported') return [];
  if (snapshot.display) return snapshot.display.version === 1 ? snapshot.display.meters : [];
  const meters: SubscriptionQuotaMeter[] = [...(snapshot.windows || [])];
  if (snapshot.details?.version === 1) {
    for (const bucket of snapshot.details.buckets || []) {
      for (const window of bucket.windows || []) {
        meters.push({ ...window, id: `${bucket.id}:${window.id}`, display_name: bucket.display_name });
      }
    }
  }
  return meters;
}

export function finiteQuota(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function remainingPercent(meter: SubscriptionQuotaMeter): number | undefined {
  const used = finiteQuota(meter.used_percent);
  return meter.unlimited || used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used));
}

export function quotaIsStale(snapshot: SubscriptionQuotaSnapshot | null, failed: boolean, now = Date.now() / 1000): boolean {
  return !!snapshot && (failed || snapshot.state === 'stale' || snapshot.state === 'query_failed'
    || snapshot.valid_until == null || snapshot.valid_until <= now);
}
