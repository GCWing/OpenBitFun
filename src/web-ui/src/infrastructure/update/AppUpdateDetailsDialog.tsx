import { Dialog } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { AppUpdatePanel } from './AppUpdatePanel';
import { useUpdateInstallStore } from './updateInstallStore';

export default function AppUpdateDetailsDialog() {
  const { t } = useI18n('common');
  const open = useUpdateInstallStore(state => state.detailsOpen);
  const close = useUpdateInstallStore(state => state.closeDetails);
  return <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) close(); }} size="lg" className="openbitfun-update-dialog"
    aria-label={t('update.detailsTitle')} data-testid="app-update-details-dialog">
    <AppUpdatePanel />
  </Dialog>;
}
