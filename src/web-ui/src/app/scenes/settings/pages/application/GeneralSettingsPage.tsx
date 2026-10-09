import '@/app/scenes/settings/pages/shared/ApplicationSettings.scss';
import { configAPI } from '@/infrastructure/api';
import type { CloseBehavior } from '@/infrastructure/api/service-api/SystemAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { ConfigLoadingState, ConfigMessage, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { createLogger } from '@/shared/utils/logger';
import { Button, Select, Switch } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
import { LanguageSettingsSection } from './LanguageSettingsSection';
const log = createLogger('GeneralSettingsPage');

function LaunchAtLoginSetting() {
  const { t } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const value = await systemAPI.getLaunchAtLoginEnabled();
      setEnabled(value);
    } catch (error) {
      log.error('Failed to load launch-at-login state', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }
    void loadData().catch(() => undefined);
  }, [isTauri, loadData]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSaving(true);
      try {
        await systemAPI.setLaunchAtLoginEnabled(next);
      } catch (error) {
        setEnabled(previous);
        log.error('Failed to set launch-at-login', { next, error });
        showMessage('error', t('launchAtLogin.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [enabled, showMessage, t]
  );

  if (!isTauri) {
    return null;
  }

  if (loading || loadFailed) {
    return (
      <ConfigPageRow
        label={t('launchAtLogin.toggleLabel')}
        description={t(loading ? 'launchAtLogin.messages.loading' : 'launchAtLogin.messages.loadFailed')}
        align="center"
      >
        <Button type="button" variant="outline" size="sm" loading={loading} disabled={loading} onClick={() => void loadData()}>
          {t('common.retry')}
        </Button>
      </ConfigPageRow>
    );
  }

  return (
    <>
      <ConfigMessage message={message} />
      <ConfigPageRow
        label={t('launchAtLogin.toggleLabel')}
        description={t('launchAtLogin.toggleDescription')}
        align="center"
      >
        <div data-openbitfun-component="application-settings" data-openbitfun-part="launchAtLogin">
          <Switch
            checked={enabled}
            onChange={(e) => {
              void handleToggle(e.target.checked);
            }}
            disabled={saving}
          />
        </div>
      </ConfigPageRow>
    </>
  );
}

function AutoUpdateSetting() {
  const { t } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      setEnabled(await systemAPI.getAutoUpdateEnabled());
    } catch (error) {
      log.error('Failed to load app.auto_update', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }
    void loadData();
  }, [isTauri, loadData]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSaving(true);
      try {
        await systemAPI.setAutoUpdateEnabled(next);
        showMessage('success', t('autoUpdate.messages.saved'));
      } catch (error) {
        setEnabled(previous);
        log.error('Failed to set app.auto_update', { next, error });
        showMessage('error', t('autoUpdate.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [enabled, showMessage, t]
  );

  if (!isTauri) {
    return null;
  }

  if (loading || loadFailed) {
    return (
      <ConfigPageRow
        label={t('autoUpdate.toggleLabel')}
        description={t(loading ? 'autoUpdate.messages.loading' : 'autoUpdate.messages.loadFailed')}
        align="center"
      >
        <Button type="button" variant="outline" size="sm" loading={loading} disabled={loading} onClick={() => void loadData()}>
          {t('common.retry')}
        </Button>
      </ConfigPageRow>
    );
  }

  return (
    <>
      <ConfigMessage message={message} />
      <ConfigPageRow
        label={t('autoUpdate.toggleLabel')}
        description={t('autoUpdate.toggleDescription')}
        align="center"
      >
        <div data-openbitfun-component="application-settings" data-openbitfun-part="autoUpdate">
          <Switch
            checked={enabled}
            onChange={(e) => {
              void handleToggle(e.target.checked);
            }}
            disabled={saving}
          />
        </div>
      </ConfigPageRow>
    </>
  );
}

function PreventSleepSetting() {
  const { t } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      setEnabled(await systemAPI.getPreventSleepEnabled());
    } catch (error) {
      log.error('Failed to load prevent-sleep preference', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }
    void loadData();
  }, [isTauri, loadData]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setSaving(true);
      try {
        await systemAPI.setPreventSleepEnabled(next);
        showMessage('success', t('preventSleep.messages.saved'));
      } catch (error) {
        setEnabled(previous);
        log.error('Failed to set prevent-sleep preference', { next, error });
        showMessage('error', t('preventSleep.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [enabled, showMessage, t]
  );

  if (!isTauri) {
    return null;
  }

  if (loading || loadFailed) {
    return (
      <ConfigPageRow
        label={t('preventSleep.toggleLabel')}
        description={t(loading ? 'preventSleep.messages.loading' : 'preventSleep.messages.loadFailed')}
        align="center"
      >
        <Button type="button" variant="outline" size="sm" loading={loading} disabled={loading} onClick={() => void loadData()}>
          {t('common.retry')}
        </Button>
      </ConfigPageRow>
    );
  }

  return (
    <>
      <ConfigMessage message={message} />
      <ConfigPageRow
        label={t('preventSleep.toggleLabel')}
        description={t('preventSleep.toggleDescription')}
        align="center"
      >
        <div data-openbitfun-component="application-settings" data-openbitfun-part="preventSleep">
          <Switch
            checked={enabled}
            onChange={(event) => {
              void handleToggle(event.target.checked);
            }}
            disabled={saving}
          />
        </div>
      </ConfigPageRow>
    </>
  );
}

function WindowBehaviorSetting() {
  const { t } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const [behavior, setBehavior] = useState<CloseBehavior>('quit');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const behaviorOptions = useMemo(
    () => [
      { value: 'quit', label: t('windowBehavior.options.quit') },
      { value: 'minimize_to_tray', label: t('windowBehavior.options.minimizeToTray') },
      { value: 'ask', label: t('windowBehavior.options.ask') },
    ],
    [t]
  );

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const value = await configManager.getOptionalConfig<CloseBehavior>('app.close_button_behavior');
      setBehavior(value ?? 'minimize_to_tray');
    } catch (error) {
      log.error('Failed to load close behavior', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }
    void loadData();
  }, [isTauri, loadData]);

  const handleChange = useCallback(
    async (value: string) => {
      const previous = behavior;
      const next = value as CloseBehavior;
      setBehavior(next);
      setSaving(true);
      try {
        await configManager.setConfig('app.close_button_behavior', next);
        configManager.clearCache();
        showMessage('success', t('windowBehavior.messages.saved'));
      } catch (error) {
        setBehavior(previous);
        log.error('Failed to save close behavior', { next, error });
        showMessage('error', t('windowBehavior.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [behavior, showMessage, t]
  );

  if (!isTauri) return null;

  if (loading) {
    return <ConfigLoadingState label={t('windowBehavior.messages.loading')} />;
  }

  if (loadFailed) {
    return (
      <ConfigRetryState
        message={t('windowBehavior.messages.loadFailed')}
        retryLabel={t('common.retry')}
        onRetry={() => void loadData()}
      />
    );
  }

  return (
    <>
      <ConfigMessage message={message} />
      <ConfigPageRow
        label={t('windowBehavior.closeButtonLabel')}
        description={t('windowBehavior.closeButtonDescription')}
        align="center"
      >
        <div data-openbitfun-component="application-settings" data-openbitfun-part="windowBehavior">
          <Select
            size="sm"
            value={behavior}
            onValueChange={(v) => { void handleChange(v as string); }}
            options={behaviorOptions}
            disabled={saving}
          />
        </div>
      </ConfigPageRow>
    </>
  );
}

function NotificationSettings() {
  const { t } = useTranslation('settings/application');
  const [dialogNotify, setDialogNotify] = useState(true);
  const [permissionRequestNotify, setPermissionRequestNotify] = useState(true);
  const [startupTips, setStartupTips] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [notify, permissionNotify, tips] = await Promise.all([
        configManager.getOptionalConfig<boolean>('app.notifications.dialog_completion_notify'),
        configManager.getOptionalConfig<boolean>('app.notifications.permission_request_notify'),
        configManager.getOptionalConfig<boolean>('app.notifications.enable_startup_tips'),
      ]);
      setDialogNotify(notify !== false);
      setPermissionRequestNotify(permissionNotify !== false);
      setStartupTips(tips !== false);
    } catch (error) {
      log.error('Failed to load notification preferences', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleDialogNotifyToggle = async (checked: boolean) => {
    setSaving(true);
    try {
      await configAPI.setConfig('app.notifications.dialog_completion_notify', checked);
      setDialogNotify(checked);
      setMessage({ type: 'success', text: t('notifications.messages.saveSuccess') });
    } catch {
      setMessage({ type: 'error', text: t('notifications.messages.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const handlePermissionRequestNotifyToggle = async (checked: boolean) => {
    setSaving(true);
    try {
      await configManager.setConfig('app.notifications.permission_request_notify', checked);
      setPermissionRequestNotify(checked);
      setMessage({ type: 'success', text: t('notifications.messages.saveSuccess') });
    } catch {
      setMessage({ type: 'error', text: t('notifications.messages.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const handleStartupTipsToggle = async (checked: boolean) => {
    setSaving(true);
    try {
      await configAPI.setConfig('app.notifications.enable_startup_tips', checked);
      setStartupTips(checked);
      setMessage({ type: 'success', text: t('notifications.messages.saveSuccess') });
    } catch {
      setMessage({ type: 'error', text: t('notifications.messages.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <ConfigLoadingState label={t('notifications.messages.loading')} />;
  }

  if (loadFailed) {
    return (
      <ConfigRetryState
        message={t('notifications.messages.loadFailed')}
        retryLabel={t('common.retry')}
        onRetry={() => void loadData()}
      />
    );
  }

  return (
    <>
      <ConfigMessage message={message} />
      <ConfigPageRow
        label={t('notifications.dialogCompletion.label')}
        description={t('notifications.dialogCompletion.description')}
        align="center"
      >
        <div data-openbitfun-component="application-settings" data-openbitfun-part="notifications">
          <Switch
            checked={dialogNotify}
            onChange={(e) => { void handleDialogNotifyToggle(e.target.checked); }}
            disabled={saving}
          />
        </div>
      </ConfigPageRow>
      <ConfigPageRow
        label={t('notifications.permissionRequest.label')}
        description={t('notifications.permissionRequest.description')}
        align="center"
      >
        <Switch
          checked={permissionRequestNotify}
          onChange={(e) => { void handlePermissionRequestNotifyToggle(e.target.checked); }}
          disabled={saving}
        />
      </ConfigPageRow>
      <ConfigPageRow
        label={t('notifications.startupTips.label')}
        description={t('notifications.startupTips.description')}
        align="center"
      >
        <Switch
          checked={startupTips}
          onChange={(e) => { void handleStartupTipsToggle(e.target.checked); }}
          disabled={saving}
        />
      </ConfigPageRow>
    </>
  );
}
const GeneralSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  return (
    <SettingsPage pageId="application.general" data-openbitfun-component="application-settings" data-openbitfun-part="root">
      <LanguageSettingsSection />
      {isTauri && (
        <ConfigPageSection title={t('applicationGroups.startupAndUpdates.title')} description={t('applicationGroups.startupAndUpdates.description')}>
          <LaunchAtLoginSetting />
          <PreventSleepSetting />
          <AutoUpdateSetting />
        </ConfigPageSection>
      )}
      <ConfigPageSection title={t('applicationGroups.windowAndNotifications.title')} description={t('applicationGroups.windowAndNotifications.description')}>
        <WindowBehaviorSetting />
        <NotificationSettings />
      </ConfigPageSection>
    </SettingsPage>
  );
};
export default GeneralSettingsPage;
