import { useEffect, useState, useSyncExternalStore } from 'react';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { SubagentAPI } from '@/infrastructure/api/service-api/SubagentAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { miniAppAPI, type MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type { SkillScanReport } from '@/infrastructure/config/types';
import {
  tokenUsageStatisticsApi,
  TokenUsageStatisticsUnavailableError,
  type UsageStatistics,
} from '@/infrastructure/api/tokenUsageStatisticsApi';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { globalEventBus } from '@/infrastructure/event-bus';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { localOverviewAgents, type OverviewAgent } from './overviewData';

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed' | 'unsupported' };
interface OverviewSnapshot {
  key: string;
  usage: LoadState<{ stats: UsageStatistics; now: Date }>;
  agents: LoadState<OverviewAgent[]>;
  miniApps: LoadState<{ apps: MiniAppMeta[]; runningWorkerIds: string[] }>;
  skills: LoadState<SkillScanReport>;
}
const loading = { status: 'loading' } as const;

export function usePersonalOverview(timeZone: string, isActive: boolean) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id;
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const key = scope.key(scope.epoch, workspaceId, timeZone);

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    globalEventBus.on('custom-agent:updated', refresh);
    globalEventBus.on('mode:config:updated', refresh);
    return () => {
      globalEventBus.off('custom-agent:updated', refresh);
      globalEventBus.off('mode:config:updated', refresh);
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const refresh = () => { if (scope.isCurrent()) setRevision(value => value + 1); };
    const unlisten = [
      api.listen('miniapp-created', refresh),
      api.listen('miniapp-updated', refresh),
      api.listen('miniapp-deleted', refresh),
      api.listen('miniapp-worker-restarted', refresh),
      api.listen('miniapp-worker-stopped', refresh),
    ];
    return () => { unlisten.forEach(remove => remove()); };
  }, [isActive, scope]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const current = () => !cancelled && scope.isCurrent();
    setSnapshot({ key, usage: loading, agents: loading, miniApps: loading, skills: loading });
    void tokenUsageStatisticsApi.getStatistics({
      timeRange: 'all', granularity: 'day', timeZone, includeSubagent: true,
    }).then(stats => {
      if (current()) setSnapshot(state => state?.key === key
        ? { ...state, usage: { status: 'ready', data: { stats, now: new Date() } } } : state);
    }).catch(error => {
      if (current()) setSnapshot(state => state?.key === key
        ? { ...state, usage: { status: error instanceof TokenUsageStatisticsUnavailableError ? 'unsupported' : 'failed' } } : state);
    });

    void Promise.all([
      agentAPI.getAvailableModes({ workspaceId }),
      SubagentAPI.listSubagents({ workspaceId }),
    ]).then(([modes, subagents]) => {
      if (current()) setSnapshot(state => state?.key === key
        ? { ...state, agents: { status: 'ready', data: localOverviewAgents(modes, subagents) } } : state);
    }).catch(() => {
      if (current()) setSnapshot(state => state?.key === key
        ? { ...state, agents: { status: 'failed' } } : state);
    });

    void Promise.all([miniAppAPI.listMiniApps(), miniAppAPI.workerListRunning()])
      .then(([apps, runningWorkerIds]) => {
        if (current()) setSnapshot(state => state?.key === key
          ? { ...state, miniApps: { status: 'ready', data: { apps, runningWorkerIds } } } : state);
      }).catch(() => {
        if (current()) setSnapshot(state => state?.key === key
          ? { ...state, miniApps: { status: 'failed' } } : state);
      });

    void configAPI.getSkillScanReport({ workspaceId }).then(report => {
      if (!current()) return;
      setSnapshot(state => state?.key === key
        ? { ...state, skills: { status: 'ready', data: report } } : state);
    }).catch(() => {
      if (current()) setSnapshot(state => state?.key === key
        ? { ...state, skills: { status: 'failed' } } : state);
    });
    return () => { cancelled = true; };
  }, [isActive, key, revision, scope, timeZone, workspaceId]);

  // Hide a previous device/workspace snapshot in the render that precedes effect cleanup.
  const visible = snapshot?.key === key ? snapshot : null;
  return {
    usage: visible?.usage ?? loading,
    agents: visible?.agents ?? loading,
    miniApps: visible?.miniApps ?? loading,
    skills: visible?.skills ?? loading,
    refresh: () => setRevision(value => value + 1),
  };
}
