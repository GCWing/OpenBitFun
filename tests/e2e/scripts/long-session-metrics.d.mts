export function distribution(values: number[]): { count: number; p50Ms: number | null; p90Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null; meanMs: number | null };
export function frameMetrics(times: number[], start: number, end: number): ReturnType<typeof distribution> & {
  durationMs: number; rafFps: number | null; overBudget: Array<{ thresholdMs: number; count: number; percent: number | null }>;
  stallEpisodes: number; longestStallFrames: number;
};
export function summarize(samples: any[]): any[];
export function renderReport(report: any): { csv: string; html: string };
