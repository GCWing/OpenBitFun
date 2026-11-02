import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch } from '@openbitfun/ui';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('DesktopCardsSettingsSection');

export default function DesktopCardsSettingsSection() {
  const { t } = useI18n('settings/runtime');
  const notification = useNotification();
  const [cachedSettings] = useState(() => aiExperienceConfigService.getCachedSettings());
  const [loading, setLoading] = useState(!cachedSettings);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<boolean | undefined>(cachedSettings?.enable_desktop_cards);
  const saveInFlight = useRef(false);

  const load = useCallback(async () => {
    setLoading(!cachedSettings);
    setLoadFailed(false);
    try {
      const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });
      setEnabled(settings.enable_desktop_cards);
    } catch (error) {
      log.error('Failed to load desktop card settings', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [cachedSettings]);

  useEffect(() => {
    if (!cachedSettings) void load();
    return aiExperienceConfigService.addChangeListener(next => {
      setEnabled(next.enable_desktop_cards);
    });
  }, [load, cachedSettings]);

  const sectionAnchor = useSettingsSectionAnchor('desktop-cards', !loading);

  const handleToggle = async (next: boolean) => {
    if (saveInFlight.current || enabled === undefined) return;
    const scope = getActiveSurfaceScope();
    saveInFlight.current = true;
    setSaving(true);
    try {
      await aiExperienceConfigService.saveSettings({ enable_desktop_cards: next });
      if (!scope.isCurrent()) return;
      setEnabled(next);
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save desktop card settings', error);
      notification.error(t('messages.saveFailed'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  if (loading || loadFailed) {
    return (
      <ConfigPageSection id={sectionAnchor} title={t('features.desktopCards.title')}>
        {loading
          ? <ConfigLoadingState label={t('loading.text')} />
          : <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void load()} />}
      </ConfigPageSection>
    );
  }

  return (
    <ConfigPageSection id={sectionAnchor} title={t('features.desktopCards.title')}>
      <ConfigPageRow
        label={t('features.desktopCards.enable')}
        align="center"
        description={enabled === undefined
          ? t('features.desktopCards.unsupported')
          : t('features.desktopCards.description')}
      >
        <Switch
          checked={enabled === true}
          onChange={event => void handleToggle(event.currentTarget.checked)}
          disabled={saving || enabled === undefined}
          aria-label={t('features.desktopCards.enable')}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
