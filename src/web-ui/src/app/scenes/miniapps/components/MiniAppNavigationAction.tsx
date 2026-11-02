import { Button, Icon } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useMiniAppNavigation } from '../miniAppNavigationStore';

export function MiniAppNavigationAction({ appId }: { appId: string }) {
  const { t } = useI18n('scenes/miniapp');
  const { pinnedAppIds, setPinned } = useMiniAppNavigation();
  const pinned = pinnedAppIds.includes(appId);
  return <Button variant="outline" size="sm" aria-pressed={pinned}
    leadingIcon={<Icon name="pin" size="sm" />}
    onClick={() => setPinned(appId, !pinned)}>
    {t(pinned ? 'navigation.remove' : 'navigation.add')}
  </Button>;
}
