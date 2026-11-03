import type { ModelRound, TokenUsage } from '../types/flow-chat';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Round-level milliseconds from model request start to stream completion.
 *
 * This intentionally includes TTFT. Providers can buffer a pseudo-stream and
 * deliver a large block after a long idle period; measuring only from the first
 * visible output would turn that wait into an implausibly high throughput.
 */
function roundRequestDurationMs(round: ModelRound): number | undefined {
  if (!isPositiveMs(round.durationMs)) return undefined;
  // Turn usage includes all attempts, but timing only covers the accepted one.
  if ((round.attemptCount ?? 1) > 1) return undefined;
  return round.durationMs;
}

/**
 * Milliseconds a turn spent in model requests, summed over its rounds.
 *
 * Tool execution and permission waits between model calls are not model request
 * time. Returns undefined if any model round lacks usable timing; partial timing
 * would make the aggregate rate unreliable.
 */
export function getTurnOutputDurationMs(rounds?: readonly ModelRound[]): number | undefined {
  if (!rounds?.length) return undefined;
  let totalMs = 0;
  for (const round of rounds) {
    // Negative indexes are controller setup/audit rows, not model calls.
    if (round.index < 0) continue;
    const durationMs = roundRequestDurationMs(round);
    if (durationMs === undefined) return undefined;
    totalMs += durationMs;
  }
  return isPositiveMs(totalMs) ? totalMs : undefined;
}

/** TTFT of the turn's first model call; later tool-driven calls are not added. */
export function getTurnTtftMs(rounds?: readonly ModelRound[]): number | undefined {
  const ttftMs = rounds?.find(round => !(round.index < 0))?.ttftMs;
  return isCount(ttftMs) ? ttftMs : undefined;
}

export function getTurnUsageMetrics(usage?: TokenUsage, outputDurationMs?: number) {
  const totalTokens = isCount(usage?.totalTokens) ? usage.totalTokens : null;
  const cacheHitRate = isCount(usage?.cachedTokens) && isCount(usage?.inputTokens)
    && usage.inputTokens > 0 && usage.cachedTokens <= usage.inputTokens
    ? usage.cachedTokens / usage.inputTokens : null;
  // `outputDurationMs` is the sum of model request durations from
  // `getTurnOutputDurationMs`, including TTFT but excluding tool execution.
  const rate = isCount(usage?.outputTokens) && isCount(outputDurationMs) && outputDurationMs > 0
    ? usage.outputTokens / (outputDurationMs / 1000) : null;
  const outputRate = rate !== null && Number.isFinite(rate) ? rate : null;
  const speedLevel: 1 | 2 | 3 | 4 | null = outputRate === null ? null
    : outputRate < 15 ? 1 : outputRate < 40 ? 2 : outputRate < 80 ? 3 : 4;
  return { totalTokens, cacheHitRate, outputRate, speedLevel };
}
