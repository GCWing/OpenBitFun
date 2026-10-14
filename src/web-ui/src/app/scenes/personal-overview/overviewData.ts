import type { ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import type { SubagentInfo } from '@/infrastructure/api/service-api/SubagentAPI';
import type { UsageStatistics } from '@/infrastructure/api/tokenUsageStatisticsApi';
import { createCalendarDateKeyFormatter } from '@/infrastructure/i18n/core/I18nService';
import { primaryAgentKind } from '@/shared/agents/identity';
import { HIDDEN_AGENT_IDS } from '../agents/agentVisibility';

const DAY_MS = 86_400_000;
export interface OverviewAgent {
  key: string;
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project';
  kind: 'agent' | 'subagent';
  toolCount: number;
}

export function localOverviewAgents(modes: ModeInfo[], subagents: SubagentInfo[]): OverviewAgent[] {
  const agents: OverviewAgent[] = [];
  for (const mode of modes) {
    if (mode.source === 'external' || primaryAgentKind(mode) === 'harness' || HIDDEN_AGENT_IDS.has(mode.id)) continue;
    agents.push({ ...mode, source: mode.source, key: `agent:${mode.id}`, kind: 'agent' });
  }
  for (const agent of subagents) {
    const source = agent.subagentSource ?? agent.source ?? 'builtin';
    if (source === 'external' || HIDDEN_AGENT_IDS.has(agent.id) || agent.visibility?.showInGlobalRegistry === false) continue;
    agents.push({ ...agent, key: `subagent:${agent.key}`, source, kind: 'subagent' });
  }
  // Personal creations lead the gallery; preserve the host's order within each source.
  const rank = { user: 0, project: 1, builtin: 2 };
  return agents.sort((a, b) => rank[a.source] - rank[b.source]);
}

/** Calendar arithmetic uses UTC date keys, so DST never inserts or drops a day. */
export function summarizeOverviewUsage(stats: UsageStatistics, timeZone: string, now: Date) {
  const dateKey = createCalendarDateKeyFormatter(timeZone);
  const today = dateKey(now);
  const daily = new Map<string, number>();
  for (const point of stats.trend) {
    const date = new Date(point.bucket);
    if (!Number.isFinite(date.getTime())) continue;
    const key = dateKey(date);
    if (key > today) continue;
    daily.set(key, (daily.get(key) ?? 0) + point.inputTokens + point.outputTokens);
  }
  const days = [...daily].sort(([a], [b]) => a.localeCompare(b));
  const recordedTokens = days.reduce((sum, [, tokens]) => sum + tokens, 0);
  let longestStreak = 0;
  let run = 0;
  let previousDay = Number.NEGATIVE_INFINITY;
  let peakTokens = 0;
  for (const [key, tokens] of days) {
    peakTokens = Math.max(peakTokens, tokens);
    if (tokens <= 0) continue;
    const day = Date.parse(`${key}T00:00:00Z`);
    run = day - previousDay === DAY_MS ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previousDay = day;
  }
  let cursor = Date.parse(`${today}T00:00:00Z`);
  const keyAt = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
  // An unfinished day does not break yesterday's streak.
  if ((daily.get(today) ?? 0) <= 0) cursor -= DAY_MS;
  let currentStreak = 0;
  while ((daily.get(keyAt(cursor)) ?? 0) > 0) {
    currentStreak += 1;
    cursor -= DAY_MS;
  }
  return {
    daily, today, peakTokens, longestStreak, currentStreak,
    firstDay: days[0]?.[0],
    lastDay: days.at(-1)?.[0],
    // The host can truncate long trend series. Never claim all-time records from a partial series.
    partial: recordedTokens !== stats.totalTokens,
  };
}
