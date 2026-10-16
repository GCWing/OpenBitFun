import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Switch } from '@openbitfun/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';

const log = createLogger('PromptSuggestionSection');

export default function PromptSuggestionSection() {
  const { t } = useI18n('settings/models');
  const notification = useNotification();
  const [cachedSettings] = useState(() => aiExperienceConfigService.getCachedSettings());
  const [loading, setLoading] = useState(!cachedSettings);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<boolean | undefined>(cachedSettings?.enable_prompt_suggestion);
  const saveInFlight = useRef(false);

  const load = useCallback(async () => {
    setLoading(!cachedSettings);
    setLoadFailed(false);
    try {
      const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });
      setEnabled(settings.enable_prompt_suggestion);
    } catch (error) {
      log.error('Failed to load prompt suggestion settings', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [cachedSettings]);

  useEffect(() => {
    if (!cachedSettings) void load();
    return aiExperienceConfigService.addChangeListener((next) => {
      setEnabled(next.enable_prompt_suggestion);
    });
  }, [load, cachedSettings]);

  const handleToggle = async (next: boolean) => {
    if (saveInFlight.current || enabled === undefined) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await aiExperienceConfigService.saveSettings({ enable_prompt_suggestion: next });
      setEnabled(next);
      notification.success(t('promptSuggestion.messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save prompt suggestion settings', error);
      notification.error(t('promptSuggestion.messages.saveFailed'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  if (loading || loadFailed) {
    return (
      <ConfigPageSection title={t('promptSuggestion.title')}>
        {loading
          ? <ConfigLoadingState label={t('promptSuggestion.loading')} />
          : <ConfigRetryState message={t('promptSuggestion.loadFailedLocked')} retryLabel={t('promptSuggestion.retry')} onRetry={() => void load()} />}
      </ConfigPageSection>
    );
  }

  return (
    <ConfigPageSection
      title={t('promptSuggestion.title')}
      description={t('promptSuggestion.subtitle')}
    >
      <ConfigPageRow
        label={t('promptSuggestion.label')}
        align="center"
        description={enabled === undefined
          ? t('promptSuggestion.unsupported')
          : t('promptSuggestion.description')}
      >
        <Switch
          checked={enabled === true}
          onChange={(event) => void handleToggle(event.currentTarget.checked)}
          disabled={saving || enabled === undefined}
          aria-label={t('promptSuggestion.label')}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
