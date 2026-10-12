import { useState } from 'react';
import { Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { useChatInputSendPreference } from '@/infrastructure/config/hooks/useChatInputSendPreference';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { SEND_DURING_TURN_CONFIG_PATH, type ChatInputSendDuringTurn } from '@/infrastructure/config/services/ChatInputSendPreference';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('MessageSendingSettingsSection');

export default function MessageSendingSettingsSection() {
  const { t } = useI18n('settings/application');
  const { behavior, error, reload } = useChatInputSendPreference();
  const [savingEpoch, setSavingEpoch] = useState<number | null>(null);
  const scope = getActiveSurfaceScope();
  const saving = savingEpoch === scope.epoch;
  const sectionAnchor = useSettingsSectionAnchor('message-sending', behavior !== null || !!error);

  const save = async (value: ChatInputSendDuringTurn) => {
    if (saving || behavior === null || behavior === value) return;
    setSavingEpoch(scope.epoch);
    try {
      await configManager.setConfig(SEND_DURING_TURN_CONFIG_PATH, value);
    } catch (reason) {
      if (scope.isCurrent()) {
        log.error('Failed to save chat input send preference', reason);
        notificationService.error(t('messageSending.saveFailed'));
      }
    } finally {
      if (scope.isCurrent()) setSavingEpoch(null);
    }
  };

  return <div id={sectionAnchor}>
    <ConfigPageSection title={t('messageSending.title')}>
      {error ? <ConfigRetryState message={t('messageSending.loadFailed')}
        retryLabel={t('common.retry')} onRetry={() => void reload()} />
        : behavior === null ? <ConfigLoadingState label={t('messageSending.loading')} />
          : <ConfigPageRow label={t('messageSending.duringTurn')}
            description={t('messageSending.description')} align="center">
            <Select size="sm" value={behavior} disabled={saving}
              aria-label={t('messageSending.duringTurn')}
              options={[
                { value: 'immediate', label: t('messageSending.immediate') },
                { value: 'queue', label: t('messageSending.queue') },
              ]}
              onValueChange={value => {
                if (value === 'immediate' || value === 'queue') void save(value);
              }} />
          </ConfigPageRow>}
    </ConfigPageSection>
  </div>;
}
