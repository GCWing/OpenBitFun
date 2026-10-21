import { Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import {
  setSessionMenuPreference,
  toggleSessionMenuAction,
  useSessionMenuPreferences,
  type SessionMenuAction,
} from '@/app/components/NavPanel/sections/sessions/sessionMenuPreferences';

const ACTIONS: SessionMenuAction[] = ['rename', 'copyId', 'duplicate', 'openStorage', 'export', 'scheduledJobs', 'archive', 'manage', 'openWorktreeWorkspace', 'delete'];
const ACTION_LABELS: Record<SessionMenuAction, string> = {
  rename: 'sessionMenu.actions.rename',
  copyId: 'sessionMenu.actions.copyId',
  duplicate: 'sessionMenu.actions.duplicate',
  openStorage: 'sessionMenu.actions.openStorage',
  export: 'sessionMenu.actions.export',
  scheduledJobs: 'sessionMenu.actions.scheduledJobs',
  archive: 'sessionMenu.actions.archive',
  manage: 'sessionMenu.actions.manage',
  openWorktreeWorkspace: 'sessionMenu.actions.openWorktreeWorkspace',
  delete: 'sessionMenu.actions.delete',
};

export default function SessionMenuPreferencesSection() {
  const { t } = useI18n('settings/appearance');
  const preferences = useSessionMenuPreferences();
  return (
    <ConfigPageSection title={t('sessionMenu.title')} description={t('sessionMenu.description')}>
      {ACTIONS.map(action => (
        <ConfigPageRow key={action} label={t(ACTION_LABELS[action])} align="center">
          <Switch
            checked={!preferences.hiddenActions.includes(action)}
            onChange={event => toggleSessionMenuAction(action, event.currentTarget.checked)}
            aria-label={t(ACTION_LABELS[action])}
          />
        </ConfigPageRow>
      ))}
      <ConfigPageRow label={t('sessionMenu.showArchiveNotice')} align="center">
        <Switch checked={preferences.showArchiveNotice} onChange={event => setSessionMenuPreference('showArchiveNotice', event.currentTarget.checked)} aria-label={t('sessionMenu.showArchiveNotice')} />
      </ConfigPageRow>
      <ConfigPageRow label={t('sessionMenu.confirmDelete')} align="center">
        <Switch checked={preferences.confirmDelete} onChange={event => setSessionMenuPreference('confirmDelete', event.currentTarget.checked)} aria-label={t('sessionMenu.confirmDelete')} />
      </ConfigPageRow>
      <ConfigPageRow label={t('sessionMenu.confirmBtwClose')} align="center">
        <Switch checked={preferences.confirmBtwClose} onChange={event => setSessionMenuPreference('confirmBtwClose', event.currentTarget.checked)} aria-label={t('sessionMenu.confirmBtwClose')} />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
