import { ConfigLoadingState, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { Switch } from '@openbitfun/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('GitCommitSettingsSection');
const COMMIT_COAUTHOR_ACCOUNT = `@${new URL('https://github.com/bitfun-ai').pathname.slice(1)}`;

export default function GitCommitSettingsSection() {
  const { t } = useTranslation('settings/quick-actions');
  const notification = useNotification();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [commitCoauthorEnabled, setCommitCoauthorEnabled] = useState<boolean | undefined>();
  const saveInFlight = useRef(false);
  const sectionAnchor = useSettingsSectionAnchor('git', !loading);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });
      setCommitCoauthorEnabled(settings.enable_git_commit_coauthor);
    } catch (error) {
      log.error('Failed to load Git commit settings', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const handleCommitCoauthorToggle = async (enabled: boolean) => {
    if (saveInFlight.current || commitCoauthorEnabled === undefined) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await aiExperienceConfigService.saveSettings({ enable_git_commit_coauthor: enabled });
      setCommitCoauthorEnabled(enabled);
      notification.success(t('messages.saved'));
    } catch (error) {
      log.error('Failed to save Git commit settings', error);
      notification.error(t('messages.saveFailed'));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  if (loading || loadFailed) {
    return <ConfigPageSection id={sectionAnchor} title={t('commitAttribution.title')}>
      {loading ? <ConfigLoadingState label={t('loading')} /> : <ConfigRetryState message={t('messages.loadFailedLocked')} retryLabel={t('messages.retry')} onRetry={() => void load()} />}
    </ConfigPageSection>;
  }
  return (
    <ConfigPageSection id={sectionAnchor}
      title={t('commitAttribution.title')}
      description={t('commitAttribution.scope')}
    >
      <ConfigPageRow
        label={t('commitAttribution.label')}
        align="center"
        description={commitCoauthorEnabled === undefined
          ? t('commitAttribution.unsupported')
          : t('commitAttribution.description', { account: COMMIT_COAUTHOR_ACCOUNT })}
      >
        <Switch
          checked={commitCoauthorEnabled === true}
          onChange={(event) => handleCommitCoauthorToggle(event.currentTarget.checked)}
          disabled={saving || commitCoauthorEnabled === undefined}
          aria-label={t('commitAttribution.label')}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
