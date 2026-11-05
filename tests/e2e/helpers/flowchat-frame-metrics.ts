import type { ScrollProbe } from '../page-objects/FlowChatScrollPage';

/** Keep ordinary latency, tail frequency and consecutive stalls together. */
export function latencyDistribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { samples: values.length, p50Ms: percentile(0.5), p90Ms: percentile(0.9),
    p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 };
}

function frameDistribution(intervals: number[]) {
  let run = 0, runMs = 0, longestRun = 0, longestRunMs = 0, episodes = 0;
  for (const value of intervals) {
    if (value > 1000 / 30) {
      if (!run) episodes++;
      run++; runMs += value;
      longestRun = Math.max(longestRun, run); longestRunMs = Math.max(longestRunMs, runMs);
    } else { run = 0; runMs = 0; }
  }
  return { ...latencyDistribution(intervals), durationMs: intervals.reduce((sum, value) => sum + value, 0),
    overBudget: [1000 / 30, 50, 100].map(thresholdMs => {
      const count = intervals.filter(value => value > thresholdMs).length;
      return { thresholdMs, count, percent: intervals.length ? count / intervals.length * 100 : 0 };
    }), stallEpisodes: episodes, longestStallFrames: longestRun, longestStallMs: longestRunMs };
}

export function probeFrameDistributions(probe: ScrollProbe) {
  const intervals = probe.frames.slice(1).map((frame, index) => ({
    start: probe.frames[index].time, end: frame.time, duration: frame.time - probe.frames[index].time,
  }));
  const first = probe.wheelTimes?.[0], last = probe.wheelTimes?.at(-1);
  return { phase: frameDistribution(intervals.map(interval => interval.duration)),
    // Include intervals crossing an input edge and its next presentation, but
    // exclude the 24-frame idle settling period from the reading denominator.
    activeWheel: first === undefined || last === undefined ? undefined
      : frameDistribution(intervals.filter(interval => interval.end >= first && interval.start <= last + 50)
        .map(interval => interval.duration)) };
}
