import { Button, OverflowText } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { useProjectResources } from './useProjectResources';
import { changedProjectFileCount } from './projectResourceStats';

type Stats = Pick<ReturnType<typeof useProjectResources>, 'git' | 'sessionCount' | 'jobs' | 'agents' | 'skills' | 'refresh'>;
export type ProjectResourceMetricTarget = 'jobs' | 'agents' | 'skills';

export function ProjectResourceMetrics({ data, onNavigate }: { data: Stats; onNavigate: (target: ProjectResourceMetricTarget) => void }) {
  const { t, formatNumber } = useI18n('scenes/project-resources');
  const git = data.git.status === 'ready' ? data.git.data : null;
  const notRepository = data.git.status === 'ready' && !git;
  const sessions = data.sessionCount.status === 'ready' ? data.sessionCount.data : null;
  const gitHint = git ? t('metrics.changesHint', { staged: formatNumber(git.staged.length),
    unstaged: formatNumber(git.unstaged.length), untracked: formatNumber(git.untracked.length), conflicts: formatNumber(git.conflicts.length) })
    : notRepository ? t('metrics.noRepository') : t('metrics.gitUnavailable');
  const metrics: { id: string; label: string; value: string; detail?: string; hint?: string; target?: ProjectResourceMetricTarget }[] = [
    { id: 'changes', label: t('metrics.pendingFiles'), value: git ? formatNumber(changedProjectFileCount(git)) : '—',
      detail: notRepository ? t('metrics.noRepository') : '', hint: gitHint },
    { id: 'sessions', label: t('metrics.sessions'), value: sessions ? formatNumber(sessions.count) : '—',
      detail: sessions?.partial ? t('metrics.sessionsIncomplete') : '', hint: t('metrics.sessionsHint') },
    { id: 'jobs', label: t('metrics.jobs'), value: data.jobs.status === 'ready' ? formatNumber(data.jobs.data.length) : '—', target: 'jobs' },
    { id: 'agents', label: t('metrics.agents'), value: data.agents.status === 'ready'
      ? formatNumber(data.agents.data.filter(agent => agent.source === 'project').length) : '—', target: 'agents' },
    { id: 'skills', label: t('metrics.skills'), value: data.skills.status === 'ready'
      ? formatNumber(data.skills.data.skills.filter(skill => !skill.isBuiltin && skill.level === 'project').length) : '—', target: 'skills',
      detail: data.skills.status === 'ready' && (data.skills.data.diagnostics.length > 0 || !data.skills.data.diagnosticsAvailable)
        ? t('metrics.resourcesIncomplete') : undefined },
  ];
  const states = [
    { label: t('metrics.pendingFiles'), state: data.git }, { label: t('metrics.sessions'), state: data.sessionCount },
    { label: t('metrics.jobs'), state: data.jobs }, { label: t('metrics.agents'), state: data.agents }, { label: t('metrics.skills'), state: data.skills },
  ];
  const failures = states.flatMap(({ label, state }) => state.status === 'failed' ? [`${label}: ${state.error}`] : []);
  return <section aria-label={t('metrics.title')}>
    <dl className="project-resources__metrics" data-openbitfun-scene="project-resources" data-openbitfun-part="metrics"
      aria-busy={states.some(({ state }) => state.status === 'loading')}>
      {metrics.map(metric => <div className="project-resources__metric" key={metric.id} title={metric.hint} data-metric={metric.id}>
        <dt className="project-resources__metric-label">{metric.label}</dt>
        <dd className="project-resources__metric-value">
          {metric.target ? <button type="button" className="project-resources__metric-link" data-overflow-trigger
            aria-label={`${metric.label} ${metric.value}`} onClick={() => onNavigate(metric.target!)}>
            <OverflowText>{metric.value}</OverflowText>
          </button> : <OverflowText>{metric.value}</OverflowText>}
        </dd>
        {metric.detail && <dd className="project-resources__metric-detail"><OverflowText>{metric.detail}</OverflowText></dd>}
      </div>)}
    </dl>
    {failures.length > 0 && <div className="project-resources__metrics-feedback" role="status">
      <details><summary>{t('metrics.partial')}</summary>{failures.map(failure => <p key={failure}>{failure}</p>)}</details>
      <Button variant="text" size="sm" onClick={data.refresh}>{t('retry')}</Button>
    </div>}
  </section>;
}
