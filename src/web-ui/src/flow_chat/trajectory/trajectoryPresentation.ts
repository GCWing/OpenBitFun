import type { StatusPillTone } from '@openbitfun/ui';
export function trajectoryStatus(status: string, t: (key: string) => string): { label: string; tone: StatusPillTone } {
  if (status === 'completed') return { label: t('shared:statuses.done'), tone: 'success' };
  if (status === 'error') return { label: t('shared:statuses.failed'), tone: 'danger' };
  if (status === 'cancelled' || status === 'rejected') return { label: t('shared:statuses.cancelled'), tone: 'neutral' };
  if (['running', 'streaming', 'receiving'].includes(status)) return { label: t('shared:statuses.running'), tone: 'accent' };
  if (status === 'unknown') return { label: t('trajectory.notRecorded'), tone: 'neutral' };
  return { label: t('trajectory.waiting'), tone: 'warning' };
}
