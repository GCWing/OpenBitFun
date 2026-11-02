import { Icon, NavigationPanelItem, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { useSidebarNavigation } from '@/app/navigation/useSidebarNavigation';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PinnedNavigationItems');

export default function PinnedNavigationItems({ navigation }: { navigation: ReturnType<typeof useSidebarNavigation> }) {
  const { t } = useI18n('common');
  const { entries, pinnedIds, selectedId, context, scope } = navigation;
  return <>{pinnedIds.map(id => {
    const entry = entries.find(candidate => candidate.id === id);
    const label = entry ? t(entry.labelKey) : t('nav.customization.unavailableEntry', { id });
    const reason = entry?.unavailableReason?.(context);
    const selected = selectedId === id;
    const unavailable = !entry || Boolean(reason);
    const itemProps = {
      className: 'openbitfun-nav-panel__top-action-item openbitfun-nav-panel__top-action-item--root',
      triggerClassName: `openbitfun-nav-panel__top-action-btn${selected ? ' is-active' : ''}`,
      'data-openbitfun-state': selected ? 'active' : '',
      'aria-label': label,
      selected,
      disabled: unavailable,
      onClick: () => {
        if (!entry || unavailable || !scope.isCurrent()) return;
        void Promise.resolve().then(() => {
          if (scope.isCurrent()) return entry.open(scope);
        }).catch(error => {
          if (!scope.isCurrent()) return;
          log.error('Failed to open sidebar destination', { id, error });
          notificationService.error(t('nav.customization.openFailed', { name: label }));
        });
      },
      leading: <span className="openbitfun-nav-panel__top-action-icon-slot"><Icon name={entry?.icon ?? 'pin'} size="sm" /></span>,
    };
    return <Tooltip key={id} content={reason ? t(reason) : label} placement="right" followCursor>
      {id === 'builtin.todos'
        ? <NavigationPanelItem {...itemProps} data-openbitfun-component="nav-panel" data-openbitfun-part="todoEntry"
            data-openbitfun-action="todos" data-testid="nav-todos-btn">{label}</NavigationPanelItem>
        : <NavigationPanelItem {...itemProps} data-openbitfun-component="nav-panel" data-openbitfun-part="topAction"
            data-openbitfun-action={id} data-testid={`nav-${id}`}>{label}</NavigationPanelItem>}
    </Tooltip>;
  })}</>;
}
