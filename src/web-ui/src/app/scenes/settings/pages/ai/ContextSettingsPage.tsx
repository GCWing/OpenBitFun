import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import {
  ConfigLoadingState,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Switch } from '@openbitfun/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';

const log = createLogger('ContextSettingsPage');

const PREFETCH_CONFIG_PATH = 'ai.enable_context_compression_prefetch';

/**
 * Context settings. Long conversations are compressed automatically so the
 * working history stays inside the model window; this page exposes the
 * compression options that apply to every session on this host.
 */
const ContextSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/context');

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [prefetchEnabled, setPrefetchEnabled] = useState(true);
  const [prefetchSaving, setPrefetchSaving] = useState(false);

  const loadPageData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    try {
      const prefetch = await configManager.getConfig<boolean>(PREFETCH_CONFIG_PATH);
      setPrefetchEnabled(prefetch ?? true);
    } catch (error) {
      log.error('Failed to load context settings', error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  const handlePrefetchChange = async (checked: boolean) => {
    if (prefetchSaving) return;
    const previous = prefetchEnabled;
    setPrefetchEnabled(checked);
    setPrefetchSaving(true);
    try {
      await configManager.setConfig(PREFETCH_CONFIG_PATH, checked);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save enable_context_compression_prefetch', error);
      notificationService.error(
        `${t('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
      setPrefetchEnabled(previous);
    } finally {
      setPrefetchSaving(false);
    }
  };

  return (
    <SettingsPage
      pageId="ai.context"
      className="openbitfun-runtime-settings"
      data-openbitfun-component="runtime-settings"
      data-openbitfun-part="root"
      data-openbitfun-view="context"
    >
      {loadError ? (
        <ConfigRetryState
          message={t('loading.failed')}
          retryLabel={t('loading.retry')}
          onRetry={() => void loadPageData()}
        />
      ) : isLoading ? (
        <ConfigLoadingState label={t('loading.text')} />
      ) : (
        <ConfigPageSection
          title={t('compression.sectionTitle')}
          description={t('compression.sectionDescription')}
        >
          <ConfigPageRow
            label={t('compression.prefetch.label')}
            description={t('compression.prefetch.description')}
            align="center"
          >
            <div
              className="openbitfun-runtime-settings__row-control"
              data-openbitfun-component="runtime-settings"
              data-openbitfun-part="control"
            >
              <Switch
                checked={prefetchEnabled}
                onChange={(event) => void handlePrefetchChange(event.target.checked)}
                disabled={prefetchSaving}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>
      )}
    </SettingsPage>
  );
};

export default ContextSettingsPage;
