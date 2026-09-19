import { Icon, MenuItem, Spinner, Tooltip } from '@openbitfun/ui';
import { useEffect, useRef } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system/services/NotificationService';
import { canCheckForAppUpdates } from './tauriEnv';
import { UpdateIndicator } from './UpdateIndicator';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';
import { formatUpdateInstallError } from './updateErrorMessage';

/** Manual discovery and deferred reminders stay in More, independently of About. */
export function UpdateMenuItems({ onCloseMenu }: { onCloseMenu: () => void }) {
  const { t } = useI18n('common');
  const state = useUpdateInstallStore();
  const { initialize } = state;
  const mounted = useRef(false);
  const supported = canCheckForAppUpdates();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (supported) void initialize(); }, [supported, initialize]);
  if (!supported) return null;

  const checking = state.checkStatus === 'checking';
  const busy = !state.initialized || checking || state.status === 'downloading' || state.status === 'installing';
  const reminder = selectHasUpdateAttention(state);
  const target = state.availableUpdate?.latestVersion ?? state.version;
  const checkLabel = checking ? t('update.checking') : t('update.checkForUpdates');
  const hint = reminder ? t('update.availableVersion', { version: state.downloadVersion ?? target })
    : checkLabel;
  const showNotice = () => { useUpdateInstallStore.getState().showNotice(); onCloseMenu(); };
  const activate = async () => {
    if (reminder) { showNotice(); return; }
    await state.checkForUpdates();
    const current = useUpdateInstallStore.getState();
    // Explicit checks report their result once, independently of the menu's lifetime.
    if (current.checkStatus === 'latest') {
      notificationService.success(t('update.noUpdate'), { title: t('update.checkForUpdates') });
    } else if (current.checkStatus === 'error' && current.checkError) {
      notificationService.error(formatUpdateInstallError(current.checkError, t), { title: t('update.checkFailed') });
    } else if (current.checkStatus === 'available' && current.availableUpdate?.latestVersion) {
      if (current.availableUpdate.latestVersion === current.version) {
        notificationService.info(t('update.readyVersion', { version: current.version }), { title: t('update.checkForUpdates') });
      } else {
        current.showNotice();
      }
    }
    if (mounted.current) onCloseMenu();
  };

  return <Tooltip content={hint} placement="right">
    <MenuItem data-testid="nav-check-updates" disabled={busy} aria-busy={checking}
      metadata={<UpdateIndicator />}
      leading={checking ? <Spinner size="sm" /> : <Icon name="refresh" size="sm" />}
      onClick={() => void activate()}>
      {checkLabel}
    </MenuItem>
  </Tooltip>;
}
