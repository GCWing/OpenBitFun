import { useCallback, useEffect, useState } from 'react';
import { agentAPI, configAPI, cronAPI } from '@/infrastructure/api';
import { SubagentAPI } from '@/infrastructure/api/service-api/SubagentAPI';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { WorkspaceInfo } from '@/shared/types';
import { localOverviewAgents } from '../personal-overview/overviewData';
import { SCHEDULED_JOBS_CHANGED_EVENT } from '@/app/components/scheduled-jobs/scheduledJobDraft';
import { loadProjectGit, loadProjectSessionCount } from './projectResourceStats';

export type ProjectLoad<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; error: string };

function useProjectLoad<T>(key: string, active: boolean, revision: number, scope: SurfaceScope,
  loader: (isCurrent: () => boolean) => Promise<T>): ProjectLoad<T> {
  const [snapshot, setSnapshot] = useState<{ key: string; value: ProjectLoad<T> }>();
  useEffect(() => {
    if (!active || !scope.isCurrent()) return;
    let cancelled = false;
    const current = () => !cancelled && scope.isCurrent();
    setSnapshot({ key, value: { status: 'loading' } });
    void loader(current).then(data => {
      if (current()) setSnapshot({ key, value: { status: 'ready', data } });
    }).catch(error => {
      if (current()) setSnapshot({ key, value: { status: 'failed', error: error instanceof Error ? error.message : String(error) } });
    });
    return () => { cancelled = true; };
  }, [active, key, loader, revision, scope]);
  return snapshot?.key === key ? snapshot.value : { status: 'loading' };
}

export function useProjectResources(workspace: WorkspaceInfo, scope: SurfaceScope, active: boolean) {
  const [revision, setRevision] = useState(0);
  const [statsRevision, setStatsRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision(value => value + 1);
    setStatsRevision(value => value + 1);
  }, []);
  const key = scope.key(scope.epoch, workspace.id, workspace.rootPath, workspace.connectionId);
  useEffect(() => {
    if (!active) return;
    const changed = () => { if (scope.isCurrent()) setRevision(value => value + 1); };
    globalEventBus.on('custom-agent:updated', changed);
    window.addEventListener(SCHEDULED_JOBS_CHANGED_EVENT, changed);
    const stop = cronAPI.onJobsChanged(changed);
    return () => {
      globalEventBus.off('custom-agent:updated', changed);
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_EVENT, changed);
      stop();
    };
  }, [active, refresh, scope]);
  const loadAgents = useCallback(async () => {
    const [modes, subagents] = await Promise.all([
      agentAPI.getAvailableModes({ workspaceId: workspace.id }),
      SubagentAPI.listSubagents({ workspaceId: workspace.id }),
    ]);
    return localOverviewAgents(modes, subagents).map(agent => ({ ...agent,
      path: agent.kind === 'agent' ? modes.find(mode => mode.id === agent.id)?.path
        : subagents.find(item => `subagent:${item.key}` === agent.key)?.path,
    }));
  }, [workspace.id]);
  const loadSkills = useCallback(() => configAPI.getSkillScanReport({ workspaceId: workspace.id }), [workspace.id]);
  const loadJobs = useCallback(() => cronAPI.listJobs({ workspaceId: workspace.id, targetKind: 'workspace' }), [workspace.id]);
  const loadGit = useCallback((current: () => boolean) => loadProjectGit(workspace.id, current), [workspace.id]);
  const loadSessionCount = useCallback(() => loadProjectSessionCount(workspace.id), [workspace.id]);
  const agents = useProjectLoad(key, active, revision, scope, loadAgents);
  const skills = useProjectLoad(key, active, revision, scope, loadSkills);
  const jobs = useProjectLoad(key, active, revision, scope, loadJobs);
  const git = useProjectLoad(key, active, statsRevision, scope, loadGit);
  const sessionCount = useProjectLoad(key, active, statsRevision, scope, loadSessionCount);
  return { agents, skills, jobs, git, sessionCount, refresh };
}
