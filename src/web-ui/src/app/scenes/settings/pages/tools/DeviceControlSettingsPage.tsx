import '@/app/scenes/settings/pages/shared/RuntimeSettings.scss';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  ConfigLoadingState,
  ConfigMessage,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRefreshButton,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { useComputerUseEnabled } from '@/infrastructure/config/hooks/useComputerUseEnabled';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { i18nService } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Icon,
  Select,
  StatusPill,
  Switch,
  type ComboboxOption
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const log = createLogger('DeviceControlSettingsPage');

const IS_TAURI_DESKTOP = typeof window !== 'undefined' && '__TAURI__' in window;

function isPeerUnsupportedBrowserControlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /is local-only and cannot run on peer|is not supported on CLI peer host/i.test(message);
}

type ComputerUseStatusPayload = {
  computerUseEnabled: boolean;
  accessibilityGranted: boolean;
  screenCaptureGranted: boolean;
  platformNote: string | null;
};

type BrowserControlLaunchResponse = {
  success: boolean;
  status: string;
  message: string | null;
  browserKind: string;
  setupUrl?: string;
};

type BrowserControlDisconnectResponse = {
  success: boolean;
  status: string;
  browserKind: string;
};

type BrowserControlBrowserOption = {
  value: string;
  label: string;
  installed: boolean;
};

function browserSetupUrlFallback(browser: string): string {
  const normalized = browser.toLowerCase();
  if (normalized.includes('edge')) return 'edge://inspect/#remote-debugging';
  if (normalized.includes('chrome')) return 'chrome://inspect/#remote-debugging';
  return '';
}

const DEFAULT_BROWSER_CONTROL_BROWSER = 'default';

const DeviceControlSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/runtime');

  const { t: tTools } = useTranslation('settings/agentic-tools');

  const [isLoading, setIsLoading] = useState(true);

  const [loadError, setLoadError] = useState(false);

  const hasLoadedPageDataRef = useRef(false);

  const { computerUseEnabled, setComputerUseEnabled } = useComputerUseEnabled();

  const peerDevice = usePeerDeviceModeOptional();

  const peerModeActive = peerDevice?.peerMode.active === true;

  const [peerBrowserControlUnsupported, setPeerBrowserControlUnsupported] = useState(false);

  const [computerUseAccess, setComputerUseAccess] = useState(false);

  const [computerUseScreen, setComputerUseScreen] = useState(false);

  const [computerUseBusy, setComputerUseBusy] = useState(false);

  const [computerUseStatusLoading, setComputerUseStatusLoading] = useState(false);

  const [computerUseStatusError, setComputerUseStatusError] = useState(false);

  const [computerUsePlatformNote, setComputerUsePlatformNote] = useState<string | null>(null);

  const [browserCdpAvailable, setBrowserCdpAvailable] = useState(false);

  const [browserReady, setBrowserReady] = useState(false);

  const [browserAutoConnectOnStartup, setBrowserAutoConnectOnStartup] = useState(false);

  const [browserDefaultCdpSupported, setBrowserDefaultCdpSupported] = useState(false);

  const [browserDefaultCdpEnabled, setBrowserDefaultCdpEnabled] = useState(false);

  const [browserSetupUrl, setBrowserSetupUrl] = useState('');

  const [browserKind, setBrowserKind] = useState('');

  const [browserVersion, setBrowserVersion] = useState<string | null>(null);

  const [browserPageCount, setBrowserPageCount] = useState(0);

  const [browserOptions, setBrowserOptions] = useState<BrowserControlBrowserOption[]>([]);

  const [preferredBrowser, setPreferredBrowser] = useState(DEFAULT_BROWSER_CONTROL_BROWSER);

  const [browserControlBusy, setBrowserControlBusy] = useState(false);

  const [browserStatusLoading, setBrowserStatusLoading] = useState(false);

  const [browserStatusError, setBrowserStatusError] = useState(false);

  const [platform, setPlatform] = useState<string>('');

  const [browserRestartPrompt, setBrowserRestartPrompt] = useState<BrowserControlLaunchResponse | null>(null);

  const refreshComputerUseStatus = useCallback(async (): Promise<boolean> => {
    if (!IS_TAURI_DESKTOP) return false;
    setComputerUseStatusLoading(true);
    setComputerUseStatusError(false);
    try {
      const s = await api.invoke<ComputerUseStatusPayload>('computer_use_get_status');
      setPeerBrowserControlUnsupported(false);
      setComputerUseEnabled(s.computerUseEnabled);
      setComputerUseAccess(s.accessibilityGranted);
      setComputerUseScreen(s.screenCaptureGranted);
      setComputerUsePlatformNote(s.platformNote);
      return true;
    } catch (error) {
      if (isPeerUnsupportedBrowserControlError(error)) {
        setPeerBrowserControlUnsupported(true);
        setComputerUseStatusError(false);
        return false;
      }
      log.error('computer_use_get_status failed', error);
      setComputerUseStatusError(true);
      return false;
    } finally {
      setComputerUseStatusLoading(false);
    }
  }, [setComputerUseEnabled]);

  const refreshBrowserControlStatus = useCallback(async () => {
    if (!IS_TAURI_DESKTOP) return;
    setBrowserStatusLoading(true);
    setBrowserStatusError(false);
    try {
      const [s, browsers] = await Promise.all([
        api.invoke<{
          cdpAvailable: boolean;
          defaultCdpSupported: boolean;
          defaultCdpEnabled: boolean;
          setupUrl?: string;
          browserReady: boolean;
          browserKind: string;
          browserVersion: string | null;
          port: number;
          pageCount: number;
        }>('browser_control_get_status', { request: { port: 9222 } }),
        api.invoke<{ options: BrowserControlBrowserOption[] }>('browser_control_list_browsers'),
      ]);
      setPeerBrowserControlUnsupported(false);
      setBrowserCdpAvailable(s.cdpAvailable);
      setBrowserDefaultCdpSupported(s.defaultCdpSupported);
      setBrowserDefaultCdpEnabled(s.defaultCdpEnabled);
      setBrowserSetupUrl(s.setupUrl ?? browserSetupUrlFallback(s.browserKind));
      setBrowserReady(s.browserReady);
      setBrowserKind(s.browserKind);
      setBrowserVersion(s.browserVersion);
      setBrowserPageCount(s.pageCount);
      setBrowserOptions(browsers.options);
    } catch (error) {
      if (isPeerUnsupportedBrowserControlError(error)) {
        setPeerBrowserControlUnsupported(true);
        setBrowserStatusError(false);
      } else {
        setBrowserStatusError(true);
        log.error('browser_control_get_status failed', error);
      }
    } finally {
      setBrowserStatusLoading(false);
    }
  }, []);

  const renderedPeerDeviceId = peerDevice?.peerMode.active
    ? peerDevice.peerMode.deviceId
    : null;

  const handleComputerUseEnabledChange = async (checked: boolean) => {
    setComputerUseBusy(true);
    setComputerUseEnabled(checked);
    try {
      await configManager.setConfig('ai.computer_use_enabled', checked);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      notificationService.success(
        checked ? t('messages.saveSuccess') : t('messages.saveSuccess'),
        { duration: 2000 }
      );
      if (checked) {
        // Proactively surface the OS permission prompt (macOS Accessibility /
        // Screen Recording) the moment the user opts in, instead of waiting
        // for the first agent tool call to fail with a permission error.
        try {
          await api.invoke('computer_use_request_permissions');
        } catch (permError) {
          log.warn('computer_use_request_permissions failed', permError);
        }
      }
      await refreshComputerUseStatus();
    } catch (error) {
      log.error('Failed to save computer_use_enabled', error);
      notificationService.error(t('messages.saveFailed'));
      setComputerUseEnabled(!checked);
    } finally {
      setComputerUseBusy(false);
    }
  };

  const handleComputerUseOpenSettings = async (pane: 'accessibility' | 'screen_capture') => {
    try {
      await api.invoke('computer_use_open_system_settings', { request: { pane } });
    } catch (error) {
      log.error('computer_use_open_system_settings failed', error);
      notificationService.error(t('messages.saveFailed'));
    }
  };

  const handleBrowserControlBrowserChange = async (value: string | number) => {
    const nextValue = String(value || DEFAULT_BROWSER_CONTROL_BROWSER);
    const previousValue = preferredBrowser;
    setPreferredBrowser(nextValue);
    setBrowserControlBusy(true);
    try {
      await configManager.setConfig(
        'ai.browser_control_preferred_browser',
        nextValue === DEFAULT_BROWSER_CONTROL_BROWSER ? '' : nextValue,
      );
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('Failed to save browser_control_preferred_browser', error);
      setPreferredBrowser(previousValue);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserAutoConnectChange = async (checked: boolean) => {
    const previousValue = browserAutoConnectOnStartup;
    setBrowserAutoConnectOnStartup(checked);
    try {
      await configManager.setConfig('ai.browser_control_auto_connect_on_startup', checked);
    } catch (error) {
      log.error('Failed to save browser_control_auto_connect_on_startup', error);
      setBrowserAutoConnectOnStartup(previousValue);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
    }
  };

  const presentBrowserControlLaunchResult = (result: BrowserControlLaunchResponse) => {
    const setupUrl = result.setupUrl
      || browserSetupUrl
      || browserSetupUrlFallback(result.browserKind);
    if (result.success) {
      notificationService.success(
        t('browserControl.connectSuccess', { browser: result.browserKind }),
        { duration: 3000 }
      );
    } else if (result.status === 'requires_user_profile_setup') {
      notificationService.info(
        t('browserControl.userProfileSetupRequired', {
          browser: result.browserKind,
          url: setupUrl,
        }),
        { duration: 12000 }
      );
    } else if (result.status === 'requires_manual_user_profile_setup') {
      // The platform could not open the settings page, so the URL itself is
      // the actionable part of the message.
      notificationService.info(
        t('browserControl.userProfileSetupManual', {
          browser: result.browserKind,
          url: setupUrl,
        }),
        { duration: 20000 }
      );
    } else if (result.status === 'user_profile_connection_failed') {
      notificationService.info(
        t('browserControl.userProfileConnectionFailed', { browser: result.browserKind }),
        { duration: 12000 }
      );
    } else if (result.status === 'needs_restart') {
      setBrowserRestartPrompt(result);
    } else if (result.message) {
      notificationService.info(result.message, { duration: 8000 });
    }
  };

  const handleBrowserControlLaunch = async () => {
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>('browser_control_launch', { request: { port: 9222 } });
      presentBrowserControlLaunchResult(result);
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_launch failed', error);
      notificationService.error(t('browserControl.connectFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlEnableDefaultCdp = async () => {
    setBrowserControlBusy(true);
    const setupUrl = browserSetupUrl || browserSetupUrlFallback(browserKind);
    const promptNotificationId = notificationService.info(
      t(
        browserDefaultCdpEnabled
          ? 'browserControl.defaultCdpConnectPrompt'
          : 'browserControl.defaultCdpEnablePrompt',
        { browser: browserKind, url: setupUrl },
      ),
      { duration: 0 },
    );
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>(
        'browser_control_enable_default_cdp',
        { request: { port: 9222 } },
      );
      notificationService.dismiss(promptNotificationId);
      presentBrowserControlLaunchResult(result);
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_enable_default_cdp failed', error);
      notificationService.error(t('browserControl.connectFailed'));
    } finally {
      notificationService.dismiss(promptNotificationId);
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlDisconnect = async () => {
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlDisconnectResponse>(
        'browser_control_disconnect',
        { request: { port: 9222 } },
      );
      notificationService.success(
        t('browserControl.disconnectSuccess', { browser: result.browserKind }),
        { duration: 4000 },
      );
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_disconnect failed', error);
      notificationService.error(t('browserControl.disconnectFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlRestart = async () => {
    if (!browserRestartPrompt) return;
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>('browser_control_restart_with_cdp', {
        request: { port: 9222 },
      });
      if (result.success) {
        notificationService.success(
          t('browserControl.restartSuccess', { browser: result.browserKind }),
          { duration: 3000 }
        );
        setBrowserRestartPrompt(null);
      } else if (result.message) {
        notificationService.info(result.message, { duration: 8000 });
      }
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_restart_with_cdp failed', error);
      notificationService.error(t('browserControl.restartFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const computerUseAccessLabel = computerUseStatusLoading
    ? t('loading.text')
    : computerUseStatusError ? t('computerUse.statusUnavailable')
      : computerUseAccess ? t('computerUse.granted') : t('computerUse.notGranted');

  const computerUseScreenLabel = computerUseStatusLoading
    ? t('loading.text')
    : computerUseStatusError ? t('computerUse.statusUnavailable')
      : computerUseScreen ? t('computerUse.granted') : t('computerUse.notGranted');

  const computerUsePlatformMessage = computerUsePlatformNote
    ? platform === 'macos'
      ? t('computerUse.platformNotes.macos')
      : platform === 'windows'
        ? t('computerUse.platformNotes.windows')
        : platform === 'linux'
          ? t('computerUse.platformNotes.linux')
          : t('computerUse.platformNotes.generic')
    : null;

  const browserStatusLabel = browserStatusLoading
    ? t('loading.text')
    : browserStatusError
      ? t('browserControl.statusUnavailable')
      : browserCdpAvailable
        ? t('browserControl.connected')
        : browserReady
          ? t('browserControl.ready')
          : t('browserControl.notConnected');

  const browserStatusDescription = !browserStatusLoading && !browserStatusError
    ? browserCdpAvailable
      ? `${browserKind} · ${i18nService.formatNumber(browserPageCount)} ${t('browserControl.tabs')}`
      : browserReady ? t('browserControl.readyNotConnected') : undefined
    : undefined;

  const browserSelectOptions: ComboboxOption[] = browserOptions.map((option) => {
    const label = option.value === DEFAULT_BROWSER_CONTROL_BROWSER
      ? t('browserControl.defaultBrowser')
      : option.label;
    return {
      value: option.value,
      label: option.installed ? label : `${label} (${t('browserControl.notInstalled')})`,
      disabled: !option.installed,
    };
  });

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) { setIsLoading(true); setLoadError(false); }
    try {
      const [
        computerUseCfg,
        browserControlPreferredBrowser,
        browserControlAutoConnect,
      ] = await Promise.all([
        configManager.getConfig<boolean>('ai.computer_use_enabled'),
        configManager.getConfig<string>('ai.browser_control_preferred_browser'),
        configManager.getConfig<boolean>('ai.browser_control_auto_connect_on_startup'),
      ]);
      if (!IS_TAURI_DESKTOP) {
        setComputerUseEnabled(computerUseCfg ?? false);
      }
      setPreferredBrowser(browserControlPreferredBrowser || DEFAULT_BROWSER_CONTROL_BROWSER);
      setBrowserAutoConnectOnStartup(browserControlAutoConnect === true);
      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, [setComputerUseEnabled]);
  useEffect(() => {

    void loadPageData();
  }, [loadPageData]);
  useEffect(() => {
    if (!IS_TAURI_DESKTOP) return;
    setPeerBrowserControlUnsupported(false);
    void refreshComputerUseStatus();
    void refreshBrowserControlStatus();
    void systemAPI.getSystemInfo()
      .then(info => setPlatform(info.platform || ''))
      .catch(error => log.warn('getSystemInfo failed', error));
  }, [peerModeActive, renderedPeerDeviceId, refreshComputerUseStatus, refreshBrowserControlStatus]);

  return (
    <SettingsPage pageId="tools.desktop-control" className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view="browser-desktop-control">
      {loadError ? (
        <ConfigRetryState message={t('loading.failed')} retryLabel={t('loading.retry')} onRetry={() => void loadPageData()} />
      ) : isLoading ? (
        <ConfigLoadingState label={t('loading.text')} />
      ) : (
        <>

          {/* ── Computer use (desktop) ─────────────────────────────── */}
          <ConfigPageSection
            title={t('computerUse.sectionTitle')}
            description={
              IS_TAURI_DESKTOP ? t('computerUse.sectionDescription') : t('computerUse.desktopOnly')
            }
            extra={IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
              <ConfigRefreshButton
                tooltip={t('computerUse.refreshStatus')}
                loading={computerUseStatusLoading}
                disabled={computerUseBusy}
                onClick={() => void refreshComputerUseStatus()}
              />
            ) : undefined}
          >
            {IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
              <>
                <ConfigMessage
                  message={computerUseStatusError
                    ? { type: 'error', text: t('computerUse.statusLoadFailed') }
                    : null}
                />
                <ConfigPageRow label={t('computerUse.enable')} description={t('computerUse.enableDesc')} align="center">
                  <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                    <Switch
                      checked={computerUseEnabled}
                      onChange={(e) => handleComputerUseEnabledChange(e.target.checked)}
                      disabled={computerUseBusy || computerUseStatusLoading || computerUseStatusError}
                    />
                  </div>
                </ConfigPageRow>
                <ConfigPageRow
                  label={t('computerUse.accessibility')}
                  description={t('computerUse.accessibilityDesc')}
                  align="center"
                  className="openbitfun-runtime-settings__status-row"
                >
                  <div
                    className="openbitfun-runtime-settings__status-actions"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="control"
                  >
                    <StatusPill
                      tone={computerUseStatusLoading ? 'neutral' : computerUseStatusError ? 'warning' : computerUseAccess ? 'success' : 'warning'}
                      role="status"
                    >
                      {computerUseAccessLabel}
                    </StatusPill>
                    {platform === 'macos' && (
                      <Button
                        className="openbitfun-runtime-settings__row-action-btn"
                        size="sm"
                        variant="outline"
                        disabled={computerUseBusy || computerUseStatusLoading}
                        onClick={() => void handleComputerUseOpenSettings('accessibility')}
                      >
                        {t('computerUse.openSettings')}
                      </Button>
                    )}
                  </div>
                </ConfigPageRow>
                <ConfigPageRow
                  label={t('computerUse.screenCapture')}
                  description={t('computerUse.screenCaptureDesc')}
                  align="center"
                  className="openbitfun-runtime-settings__status-row"
                >
                  <div
                    className="openbitfun-runtime-settings__status-actions"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="control"
                  >
                    <StatusPill
                      tone={computerUseStatusLoading ? 'neutral' : computerUseStatusError ? 'warning' : computerUseScreen ? 'success' : 'warning'}
                      role="status"
                    >
                      {computerUseScreenLabel}
                    </StatusPill>
                    {platform === 'macos' && (
                      <Button
                        className="openbitfun-runtime-settings__row-action-btn"
                        size="sm"
                        variant="outline"
                        disabled={computerUseBusy || computerUseStatusLoading}
                        onClick={() => void handleComputerUseOpenSettings('screen_capture')}
                      >
                        {t('computerUse.openSettings')}
                      </Button>
                    )}
                  </div>
                </ConfigPageRow>
                {computerUsePlatformMessage && (
                  <div
                    className="openbitfun-runtime-settings__platform-note"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="platformNote"
                    role="note"
                  >
                    <Icon
                      aria-hidden="true"
                      className="openbitfun-runtime-settings__platform-note-icon"
                      name="info"
                      size="sm"
                    />
                    <p className="openbitfun-runtime-settings__platform-note-copy">
                      <strong>{t('computerUse.platformNote')}: </strong>
                      {computerUsePlatformMessage}
                    </p>
                  </div>
                )}
              </>
            ) : peerBrowserControlUnsupported ? (
              <ConfigPageRow
                label={t('computerUse.peerUnsupported')}
                description=""
                align="center"
              >
                <span />
              </ConfigPageRow>
            ) : null}
          </ConfigPageSection>

          {/* ── Browser control (CDP) ──────────────────────────────── */}
          <ConfigPageSection
            title={t('browserControl.sectionTitle')}
            extra={IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
              <ConfigRefreshButton
                tooltip={t('browserControl.refreshStatus')}
                loading={browserStatusLoading}
                disabled={browserControlBusy}
                onClick={() => void refreshBrowserControlStatus()}
              />
            ) : undefined}
            description={
              IS_TAURI_DESKTOP ? t('browserControl.sectionDescription') : t('browserControl.desktopOnly')
            }
          >
            {IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
              <>
                <ConfigMessage
                  message={browserStatusError
                    ? { type: 'error', text: t('browserControl.statusLoadFailed') }
                    : null}
                />
                <ConfigPageRow
                  label={t('browserControl.preferredBrowser')}
                  description={t(browserCdpAvailable ? 'browserControl.preferredBrowserConnectedDesc' : 'browserControl.preferredBrowserDesc')}
                  align="center"
                >
                  <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                    <Select
                      value={preferredBrowser}
                      options={browserSelectOptions}
                      size="sm"
                      disabled={browserCdpAvailable || browserControlBusy || browserStatusLoading || browserStatusError || browserSelectOptions.length === 0}
                      onValueChange={(value) => void handleBrowserControlBrowserChange(value)}
                    />
                  </div>
                </ConfigPageRow>
                {browserDefaultCdpSupported && (
                  <ConfigPageRow
                    label={t('browserControl.defaultCdp')}
                    description={t('browserControl.defaultCdpDesc')}
                    align="center"
                    className="openbitfun-runtime-settings__status-row"
                  >
                    <div
                      className="openbitfun-runtime-settings__status-actions"
                      data-openbitfun-component="runtime-settings"
                      data-openbitfun-part="control"
                    >
                      <StatusPill
                        tone={browserStatusLoading ? 'neutral' : browserStatusError ? 'warning' : browserDefaultCdpEnabled ? 'success' : 'neutral'}
                        role="status"
                      >
                        {t(browserStatusLoading ? 'loading.text' : browserStatusError ? 'browserControl.statusUnavailable' : browserDefaultCdpEnabled
                          ? 'browserControl.defaultCdpEnabled'
                          : 'browserControl.defaultCdpDisabled')}
                      </StatusPill>
                    </div>
                  </ConfigPageRow>
                )}
                {browserDefaultCdpSupported && (
                  <ConfigPageRow
                    label={t('browserControl.autoConnectOnStartup')}
                    description={t('browserControl.autoConnectOnStartupDesc')}
                    align="center"
                  >
                    <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                      <Switch
                        checked={browserAutoConnectOnStartup}
                        onChange={(e) => void handleBrowserAutoConnectChange(e.target.checked)}
                        disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                      />
                    </div>
                  </ConfigPageRow>
                )}
                <ConfigPageRow
                  label={t('browserControl.status')}
                  description={browserStatusDescription}
                  align="center"
                  className="openbitfun-runtime-settings__status-row"
                >
                  <div
                    className="openbitfun-runtime-settings__status-actions"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="control"
                  >
                    <StatusPill
                      tone={browserStatusLoading ? 'neutral' : browserStatusError ? 'warning' : browserCdpAvailable ? 'success' : 'neutral'}
                      role="status"
                      title={browserCdpAvailable && browserVersion ? `${browserKind} ${browserVersion}` : undefined}
                    >
                      {browserStatusLabel}
                    </StatusPill>
                    {browserCdpAvailable ? (
                      <Button
                        className="openbitfun-runtime-settings__row-action-btn"
                        size="sm"
                        variant="outline"
                        disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                        onClick={() => void handleBrowserControlDisconnect()}
                      >
                        {t('browserControl.disconnect')}
                      </Button>
                    ) : (
                      <Button
                        className="openbitfun-runtime-settings__row-action-btn"
                        size="sm"
                        variant="outline"
                        disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                        onClick={() => void (browserDefaultCdpSupported
                          ? handleBrowserControlEnableDefaultCdp()
                          : handleBrowserControlLaunch())}
                      >
                        {t(browserDefaultCdpSupported && !browserDefaultCdpEnabled
                          ? 'browserControl.enableDefaultCdp'
                          : 'browserControl.connect')}
                      </Button>
                    )}
                  </div>
                </ConfigPageRow>
              </>
            ) : peerBrowserControlUnsupported ? (
              <ConfigPageRow
                label={t('browserControl.peerUnsupported')}
                description=""
                align="center"
              >
                <span />
              </ConfigPageRow>
            ) : null}
          </ConfigPageSection>

          <Dialog
            open={browserRestartPrompt !== null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen && !browserControlBusy) setBrowserRestartPrompt(null);
            }}
            size="sm"
            closeOnPointerOutside={!browserControlBusy}
          >
            <DialogHeader>
              <DialogHeading>
                <DialogTitle>{t('browserControl.restartModal.title')}</DialogTitle>
              </DialogHeading>
              <DialogClose />
            </DialogHeader>
            <DialogBody>
              <div className="openbitfun-debug-config__modal-body" data-openbitfun-component="runtime-settings" data-openbitfun-part="restartModal">
                <p>{t('browserControl.restartModal.description', { browser: browserRestartPrompt?.browserKind || browserKind })}</p>
                <p>{t('browserControl.restartModal.warning')}</p>
                {browserRestartPrompt?.message ? (
                  <p className="openbitfun-runtime-settings__hint">{browserRestartPrompt.message}</p>
                ) : null}
              </div>
            </DialogBody>
            <DialogFooter
              separator
              className="openbitfun-debug-config__modal-footer"
              data-openbitfun-component="runtime-settings"
              data-openbitfun-part="modalFooter"
            >
              <Button
                variant="fill"
                size="sm"
                onClick={() => setBrowserRestartPrompt(null)}
                disabled={browserControlBusy}
              >
                {t('browserControl.restartModal.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleBrowserControlRestart()}
                disabled={browserControlBusy}
              >
                {browserControlBusy
                  ? t('browserControl.restartModal.restarting')
                  : t('browserControl.restartModal.confirm')}
              </Button>
            </DialogFooter>
          </Dialog>

        </>
      )}
    </SettingsPage>
  );
};

export default DeviceControlSettingsPage;
