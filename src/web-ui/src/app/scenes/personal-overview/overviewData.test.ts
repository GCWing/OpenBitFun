import { describe, expect, it } from 'vitest';
import type { UsageStatistics, UsageTrendPoint } from '@/infrastructure/api/tokenUsageStatisticsApi';
import type { ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import type { SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import { localOverviewAgents, summarizeOverviewUsage } from './overviewData';

function point(bucket: string, tokens: number): UsageTrendPoint {
  return { bucket, inputTokens: tokens, outputTokens: 0, cacheReadTokens: tokens, cacheWriteTokens: 0, cacheHitRate: 1 };
}
function stats(trend: UsageTrendPoint[], totalTokens = trend.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0)): UsageStatistics {
  return {
    totalRequests: trend.length, totalTokens, totalInputTokens: totalTokens, totalOutputTokens: 0,
    totalCachedTokens: totalTokens, totalCacheWriteTokens: 0, totalCacheReportedInputTokens: totalTokens,
    byModel: [], byGroup: [], byEndpoint: [], trend, granularity: 'day',
  };
}

describe('personal overview activity', () => {
  it('counts calendar days in the selected time zone without double-counting cached tokens', () => {
    const summary = summarizeOverviewUsage(stats([
      point('2026-10-12T16:00:00Z', 10),
      point('2026-10-13T02:00:00Z', 20),
      point('2026-10-13T16:00:00Z', 40),
    ]), 'Asia/Shanghai', new Date('2026-10-14T12:00:00Z'));
    expect(summary.peakTokens).toBe(40);
    expect(summary.daily.get('2026-10-13')).toBe(30);
    expect(summary.longestStreak).toBe(2);
    expect(summary.currentStreak).toBe(2);
    expect(summary.partial).toBe(false);
  });

  it('keeps yesterday’s streak until today finishes and breaks it after a missing day', () => {
    const data = stats([point('2026-10-12T00:00:00Z', 10), point('2026-10-13T00:00:00Z', 10)]);
    expect(summarizeOverviewUsage(data, 'UTC', new Date('2026-10-14T12:00:00Z')).currentStreak).toBe(2);
    expect(summarizeOverviewUsage(data, 'UTC', new Date('2026-10-15T12:00:00Z')).currentStreak).toBe(0);
  });

  it('handles DST, duplicate dates, zero usage, and unsorted input', () => {
    const summary = summarizeOverviewUsage(stats([
      point('2024-03-11T04:00:00Z', 30),
      point('2024-03-10T05:00:00Z', 10),
      point('2024-03-09T05:00:00Z', 20),
      point('2024-03-10T08:00:00Z', 10),
      point('2024-03-08T05:00:00Z', 0),
    ]), 'America/New_York', new Date('2024-03-11T18:00:00Z'));
    expect(summary.longestStreak).toBe(3);
    expect(summary.currentStreak).toBe(3);
    expect(summary.peakTokens).toBe(30);
  });

  it('identifies a truncated history without presenting records as all-time', () => {
    const summary = summarizeOverviewUsage(stats([point('2026-10-14T00:00:00Z', 50)], 250), 'UTC', new Date('2026-10-14T12:00:00Z'));
    expect(summary.partial).toBe(true);
    expect(summary.peakTokens).toBe(50);
  });

  it('reports a real empty history as zero activity', () => {
    const summary = summarizeOverviewUsage(stats([]), 'UTC', new Date('2026-10-14T12:00:00Z'));
    expect([summary.peakTokens, summary.currentStreak, summary.longestStreak]).toEqual([0, 0, 0]);
  });
});

describe('local Agent catalog', () => {
  const mode = (id: string, source: ModeInfo['source']): ModeInfo => ({
    id, source, name: id, description: '', isReadonly: false, toolCount: 2,
    promptCacheScopeKey: id, configProfileId: id, configProfileMemberModeIds: [id],
  });
  const subagent = (id: string, source: SubagentInfo['source']): SubagentInfo => ({
    id, key: id, source, name: id, description: '', isReadonly: false, isReview: false,
    toolCount: 2, defaultTools: [], defaultEnabled: true, effectiveEnabled: true,
  });

  it('excludes external providers, harnesses and hidden roles, and orders personal Agents first', () => {
    const hidden = { ...subagent('Hidden', 'builtin'), visibility: { exposure: 'hidden' as const, allowedParentAgentIds: [], deniedParentAgentIds: [], showInGlobalRegistry: false } };
    const result = localOverviewAgents([
      mode('Standard', 'builtin'), mode('Claw', 'builtin'), mode('MyAgent', 'user'), mode('External', 'external'),
    ], [subagent('ReviewJudge', 'builtin'), hidden, subagent('Local', 'project'), subagent('ExternalSub', 'external')]);
    expect(result.map(agent => agent.id)).toEqual(['MyAgent', 'Local', 'Claw']);
  });

  it('supports legacy subagents without optional source or visibility fields', () => {
    expect(localOverviewAgents([], [subagent('Legacy', undefined)])[0].source).toBe('builtin');
  });
});
