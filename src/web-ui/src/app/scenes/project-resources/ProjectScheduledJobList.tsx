import { Icon } from '@openbitfun/ui';
import { CalendarClock } from 'lucide-react';
import type { CronJob } from '@/infrastructure/api/service-api/CronAPI';
import { useI18n } from '@/infrastructure/i18n';
import { ProjectResourceList } from './ProjectResourceList';

export function ProjectScheduledJobList({ jobs, onOpen }: { jobs: CronJob[]; onOpen: () => void }) {
  const { t, formatDate, formatNumber } = useI18n('scenes/project-resources');
  return <ProjectResourceList label={t('automation.listTitle')} moreLabel={t('showAll', { count: formatNumber(jobs.length) })}
    onShowAll={onOpen} items={jobs.map(job => ({
      id: job.id, name: job.name, icon: <Icon glyph={CalendarClock} size="sm" />, onClick: onOpen,
      meta: !job.enabled ? t('automation.paused')
        : job.state.lastRunStatus === 'error' ? t('shared:statuses.failed')
          : job.state.lastRunStatus === 'running' ? t('shared:statuses.running')
            : job.state.nextRunAtMs ? formatDate(job.state.nextRunAtMs, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : t('automation.noNextRun'),
    }))} />;
}
