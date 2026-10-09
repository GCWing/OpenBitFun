import { useState } from 'react';
import { Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import {
  ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState,
} from '@/infrastructure/config/components/common';
import {
  AUTO_SHOW_SELECTION_TOOLBAR_CONFIG_PATH, useSelectionToolbarPreference,
} from '@/infrastructure/config/hooks/useSelectionToolbarPreference';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('TextSelectionSettingsSection');

export default function TextSelectionSettingsSection() {
  const { t } = useI18n('settings/application');
  const { enabled, error, reload } = useSelectionToolbarPreference();
  const [savingEpoch, setSavingEpoch] = useState<number | null>(null);
  const scope = getActiveSurfaceScope();
  const saving = savingEpoch === scope.epoch;
  const sectionAnchor = useSettingsSectionAnchor('text-selection', enabled !== null || !!error);

  const save = async (value: boolean) => {
    if (saving || enabled === null) return;
    setSavingEpoch(scope.epoch);
    try {
      await configManager.setConfig(AUTO_SHOW_SELECTION_TOOLBAR_CONFIG_PATH, value);
    } catch (reason) {
      if (scope.isCurrent()) {
        log.error('Failed to save selection toolbar preference', reason);
        notificationService.error(t('textSelection.saveFailed'));
      }
    } finally {
      if (scope.isCurrent()) setSavingEpoch(null);
    }
  };

  return (
    <div id={sectionAnchor}>
      <ConfigPageSection title={t('textSelection.title')}>
        {error ? <ConfigRetryState message={t('textSelection.loadFailed')}
          retryLabel={t('common.retry')} onRetry={() => void reload()} />
          : enabled === null ? <ConfigLoadingState label={t('textSelection.loading')} />
          : <ConfigPageRow label={t('textSelection.autoShowToolbar')}
            description={t('textSelection.autoShowToolbarDescription')} align="center">
            <Switch checked={enabled} disabled={saving} onCheckedChange={value => void save(value)}
              aria-label={t('textSelection.autoShowToolbar')} />
          </ConfigPageRow>}
      </ConfigPageSection>
    </div>
  );
}
