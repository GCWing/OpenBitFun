import type { ModelRound, TokenUsage } from '../types/flow-chat';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Round-level milliseconds spent actually receiving model output.
 *
 * Both marks use the host's stream-processing clock. The first upstream chunk
 * can contain only metadata, so generation starts at the first effective output
 * (text, thinking or a tool event), not `firstChunkMs`. Request-level TTFT also
 * includes time before streaming starts and must not be subtracted here again.
 */
function roundOutputDurationMs(round: ModelRound): number | undefined {
  if (!isPositiveMs(round.streamDurationMs)) return undefined;
  if (!isCount(round.firstVisibleOutputMs) || round.firstVisibleOutputMs >= round.streamDurationMs) {
    return undefined;
  }
  // Turn usage includes all attempts, but timing only covers the accepted one.
  if ((round.attemptCount ?? 1) > 1) return undefined;
  return round.streamDurationMs - round.firstVisibleOutputMs;
}

/**
 * Milliseconds a turn spent streaming model output, summed over its rounds.
 *
 * Turn wall time also covers tool execution, permission waits and retries, so
 * dividing output tokens by it understates throughput by a wide margin. Returns
 * undefined if any round lacks usable timing. Using partial timing with the
 * whole turn's token count would overstate throughput; wall time is no fallback.
 */
export function getTurnOutputDurationMs(rounds?: readonly ModelRound[]): number | undefined {
  if (!rounds?.length) return undefined;
  let totalMs = 0;
  for (const round of rounds) {
    // Negative indexes are controller setup/audit rows, not model calls.
    if (round.index < 0) continue;
    const durationMs = roundOutputDurationMs(round);
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
  // `outputDurationMs` must be the streaming window from `getTurnOutputDurationMs`,
  // never turn wall time: tool execution and waiting would deflate the rate.
  const rate = isCount(usage?.outputTokens) && isCount(outputDurationMs) && outputDurationMs > 0
    ? usage.outputTokens / (outputDurationMs / 1000) : null;
  const outputRate = rate !== null && Number.isFinite(rate) ? rate : null;
  const speedLevel: 1 | 2 | 3 | 4 | null = outputRate === null ? null
    : outputRate < 15 ? 1 : outputRate < 40 ? 2 : outputRate < 80 ? 3 : 4;
  return { totalTokens, cacheHitRate, outputRate, speedLevel };
}
