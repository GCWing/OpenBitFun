import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { useAIExperienceSettings } from '@/infrastructure/config/hooks';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { WORKSPACE_SEARCH_AVAILABLE } from '@/infrastructure/config/workspaceSearchAvailability';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types/global-state';
import { createLogger } from '@/shared/utils/logger';
import { Switch } from '@openbitfun/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('WorkspaceSearchSection');

function WorkspaceSearchSettings() {
  const { t } = useTranslation('settings/runtime');
  const { settings, isLoading, error, reload } = useAIExperienceSettings();
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const sectionAnchor = useSettingsSectionAnchor('workspace-search', !isLoading);

  const updateEnabled = async (enabled: boolean) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await aiExperienceConfigService.saveSettings({ enable_workspace_search: enabled });
    } catch (error) {
      log.error('Failed to save workspace search settings', error);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <ConfigPageSection id={sectionAnchor} title={t('features.workspaceSearch.title')} description={t('features.workspaceSearch.subtitle')}>
      {isLoading ? <ConfigLoadingState label={t('loading.text')} /> : error || !settings ? (
        <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void reload()} />
      ) : (
        <ConfigPageRow label={t('features.workspaceSearch.enable')} align="center">
          <Switch checked={settings.enable_workspace_search} disabled={saving} onChange={event => void updateEnabled(event.currentTarget.checked)} />
        </ConfigPageRow>
      )}
    </ConfigPageSection>
  );
}

export default function WorkspaceSearchSection() {
  const { workspace } = useCurrentWorkspace();
  if (!WORKSPACE_SEARCH_AVAILABLE || isRemoteWorkspace(workspace)) return null;
  return <WorkspaceSearchSettings />;
}
