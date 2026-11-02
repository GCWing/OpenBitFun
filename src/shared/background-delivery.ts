/** Versioned host-owned delivery facts. Unknown hosts and records retain visible delivery. */
export interface BackgroundDelivery {
  schemaVersion: 1;
  source: 'scheduled_job';
  taskId: string;
  runId: string;
  executionGeneration?: number;
  policy: 'inherit' | 'always' | 'conditional';
  disposition: 'pending' | 'quiet' | 'report' | 'attention';
  decisionSource?: string;
  reason?: string;
  resolvedAtMs?: number;
  decisionUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number };
}

export function readBackgroundDelivery(value: unknown, runId: string): BackgroundDelivery | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.source !== 'scheduled_job' || data.runId !== runId
    || typeof data.taskId !== 'string' || !data.taskId.trim()
    || !['inherit', 'always', 'conditional'].includes(String(data.policy ?? 'inherit'))
    || !['pending', 'quiet', 'report', 'attention'].includes(String(data.disposition))) return undefined;
  if (data.disposition === 'quiet' && (typeof data.resolvedAtMs !== 'number' || !Number.isFinite(data.resolvedAtMs))) return undefined;
  if (data.executionGeneration !== undefined && (!Number.isInteger(data.executionGeneration) || (data.executionGeneration as number) < 0)) return undefined;
  return { ...data, policy: data.policy ?? 'inherit' } as BackgroundDelivery;
}

export function backgroundDeliveryFromMetadata(metadata: unknown, runId: string): BackgroundDelivery | undefined {
  return readBackgroundDelivery((metadata as Record<string, unknown> | undefined)?.backgroundDelivery, runId);
}

export function suppressesBackgroundPresentation(delivery: BackgroundDelivery | undefined, status?: string): boolean {
  if (!delivery || delivery.policy === 'always' || ['error', 'failed', 'cancelled', 'cancelling', 'interrupted'].includes(status ?? '')) return false;
  if (delivery.disposition === 'quiet') return true;
  return delivery.disposition === 'pending' && ['active', 'processing', 'pending', 'image_analyzing'].includes(status ?? '');
}

export function shouldDeliverBackgroundCompletion(event: {
  turnId?: string; turn_id?: string; backgroundDelivery?: unknown; background_delivery?: unknown;
  success?: boolean; finishReason?: string; finish_reason?: string;
  partialRecoveryReason?: unknown; partial_recovery_reason?: unknown;
}): boolean {
  if (event.success === false || event.partialRecoveryReason || event.partial_recovery_reason) return true;
  const finish = event.finishReason ?? event.finish_reason;
  if (finish && !['complete', 'end_turn', 'stop', 'background_quiet'].includes(finish)) return true;
  const delivery = readBackgroundDelivery(event.backgroundDelivery ?? event.background_delivery, event.turnId ?? event.turn_id ?? '');
  return !delivery || delivery.policy === 'always' || delivery.disposition !== 'quiet';
}
