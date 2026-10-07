import type { TokenUsage } from '../types/flow-chat';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function getTurnUsageMetrics(usage?: TokenUsage, durationMs?: number) {
  const totalTokens = isCount(usage?.totalTokens) ? usage.totalTokens : null;
  const cacheHitRate = isCount(usage?.cachedTokens) && isCount(usage?.inputTokens)
    && usage.inputTokens > 0 && usage.cachedTokens <= usage.inputTokens
    ? usage.cachedTokens / usage.inputTokens : null;
  // Turn wall time is available live and after hydration, including tool/wait time.
  // It must not be presented as the provider's pure streaming throughput.
  const rate = isCount(usage?.outputTokens) && isCount(durationMs) && durationMs > 0
    ? usage.outputTokens / (durationMs / 1000) : null;
  const outputRate = rate !== null && Number.isFinite(rate) ? rate : null;
  const speedLevel: 1 | 2 | 3 | 4 | null = outputRate === null ? null
    : outputRate < 15 ? 1 : outputRate < 40 ? 2 : outputRate < 80 ? 3 : 4;
  return { totalTokens, cacheHitRate, outputRate, speedLevel };
}
