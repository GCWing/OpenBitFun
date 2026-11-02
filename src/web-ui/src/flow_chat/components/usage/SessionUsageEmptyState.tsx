import { Empty, Icon } from '@openbitfun/ui';
import { ChartPie } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';

export function SessionUsageEmptyState() {
  const { t } = useI18n('flow-chat');
  return (
    <Empty
      data-testid="session-usage-empty"
      role="status"
      icon={<Icon glyph={ChartPie} />}
      title={t('usage.empty.session')}
    />
  );
}
