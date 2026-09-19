import { Alert, Button, Combobox, ConfirmDialog, IconButton, Input, Select, Switch, Tooltip, type ComboboxOption } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FolderOpen } from 'lucide-react';
import { ConfigLoadingState, ConfigMessage, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configAPI, workspaceAPI } from '@/infrastructure/api';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import type { CloseBehavior } from '@/infrastructure/api/service-api/SystemAPI';
import { getTerminalService } from '@/tools/terminal/services';
import type { ShellInfo } from '@/tools/terminal/types/session';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import { configManager } from '../services/ConfigManager';
import { createLogger } from '@/shared/utils/logger';
import type {
  BackendLogLevel,
  RuntimeLoggingInfo,
  TerminalConfig as TerminalSettings,
} from '../types';
import './ApplicationSettingsPages.scss';

const log = createLogger('ApplicationSettings');

// Combobox reserves the empty string for no selection; config uses it for auto-detection.
const AUTO_DETECT_SHELL_VALUE = '__auto_detect_shell__';

type TerminalShellOption = ComboboxOption & {
  shell?: ShellInfo;
};

const formatShellLabel = (shell: ShellInfo): string =>
  `${shell.name}${shell.version ? ` (${shell.version})` : ''}`;

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

function LoggingSection() {
  const { t } = useTranslation('settings/application');
  const [configLevel, setConfigLevel] = useState<BackendLogLevel>('info');
  const [includeSensitiveDiagnostics, setIncludeSensitiveDiagnostics] = useState(false);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeLoggingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const levelOptions = useMemo(
    () => [
      { value: 'trace', label: t('logging.levels.trace') },
      { value: 'debug', label: t('logging.levels.debug') },
      { value: 'info', label: t('logging.levels.info') },
      { value: 'warn', label: t('logging.levels.warn') },
      { value: 'error', label: t('logging.levels.error') },
      { value: 'off', label: t('logging.levels.off') },
    ],
    [t]
  );

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);

      const [savedLevel, savedIncludeSensitiveDiagnostics, info] = await Promise.all([
        configManager.getConfig<BackendLogLevel>('app.logging.level'),
        configManager.getConfig<boolean>('app.logging.include_sensitive_diagnostics'),
        configAPI.getRuntimeLoggingInfo(),
      ]);

      setConfigLevel(savedLevel || info.effectiveLevel || 'info');
      setIncludeSensitiveDiagnostics(savedIncludeSensitiveDiagnostics ?? false);
      setRuntimeInfo(info);
    } catch (error) {
      log.error('Failed to load logging config', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleLevelChange = useCallback(
    async (value: string) => {
      const nextLevel = value as BackendLogLevel;
      const previousLevel = configLevel;
      setConfigLevel(nextLevel);
      setSaving(true);

      try {
        await configManager.setConfig('app.logging.level', nextLevel);
        configManager.clearCache();

        const info = await configAPI.getRuntimeLoggingInfo();
        setRuntimeInfo(info);
        showMessage('success', t('logging.messages.levelUpdated'));
      } catch (error) {
        setConfigLevel(previousLevel);
        log.error('Failed to update logging level', { nextLevel, error });
        showMessage('error', t('logging.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [configLevel, showMessage, t]
  );

  const handleSensitiveDiagnosticsChange = useCallback(
    async (checked: boolean) => {
      const previousValue = includeSensitiveDiagnostics;
      setIncludeSensitiveDiagnostics(checked);
      setSaving(true);

      try {
        await configManager.setConfig('app.logging.include_sensitive_diagnostics', checked);
        configManager.clearCache();
        showMessage('success', t('logging.messages.sensitiveDiagnosticsUpdated'));
      } catch (error) {
        setIncludeSensitiveDiagnostics(previousValue);
        log.error('Failed to update sensitive diagnostics logging preference', { checked, error });
        showMessage('error', t('logging.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [includeSensitiveDiagnostics, showMessage, t]
  );

  const handleOpenFolder = useCallback(async () => {
    const folder = runtimeInfo?.sessionLogDir;
    if (!folder) {
      showMessage('error', t('logging.messages.pathUnavailable'));
      return;
    }

    try {
      setOpeningFolder(true);
      await workspaceAPI.revealInExplorer(folder);
    } catch (error) {
      log.error('Failed to open log folder', { folder, error });
      showMessage('error', t('logging.messages.openFailed'));
    } finally {
      setOpeningFolder(false);
    }
  }, [runtimeInfo?.sessionLogDir, showMessage, t]);

  const handleExportDiagnostics = useCallback(async () => {
    setExportConfirmOpen(false);
    try {
      setExportingDiagnostics(true);
      const result = await configAPI.exportDiagnosticsBundle();
      showMessage('success', t('logging.messages.diagnosticsExported'));
      await workspaceAPI.revealInExplorer(result.bundlePath);
    } catch (error) {
      log.error('Failed to export diagnostics bundle', { error });
      showMessage('error', t('logging.messages.diagnosticsExportFailed'));
    } finally {
      setExportingDiagnostics(false);
    }
  }, [showMessage, t]);

  if (loading) {
    return <ConfigLoadingState label={t('logging.messages.loading')} />;
  }

  if (loadFailed) {
    return (
      <ConfigRetryState
        message={t('logging.messages.loadFailed')}
        retryLabel={t('common.retry')}
        onRetry={() => void loadData()}
      />
    );
  }

  return (
    <div className="openbitfun-logging-config" data-openbitfun-component="application-settings" data-openbitfun-part="logging">
      <div className="openbitfun-logging-config__content">
        <ConfigMessage message={message} />

        {runtimeInfo?.previousUnexpectedExit?.detected && (
          <Alert
            tone={runtimeInfo.previousUnexpectedExit.category === 'crash' ? 'warning' : 'info'}
            message={t(
              runtimeInfo.previousUnexpectedExit.category === 'crash'
                ? 'logging.previousCrash.title'
                : 'logging.previousUncleanShutdown.title'
            )}
            description={t(
              runtimeInfo.previousUnexpectedExit.category === 'crash'
                ? 'logging.previousCrash.description'
                : 'logging.previousUncleanShutdown.description',
              {
                path: runtimeInfo.previousUnexpectedExit.sessionLogDir || '-',
              }
            )}
          />
        )}

        <ConfigPageSection
          title={t('logging.sections.logging')}
          description={t('logging.sections.loggingHint')}
        >
          <ConfigPageRow
            label={t('logging.sections.level')}
            description={t('logging.level.description')}
            align="center"
          >
            <Select
              value={configLevel}
              size="sm"
              onValueChange={(v) => handleLevelChange(v as string)}
              options={levelOptions}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('logging.sensitiveDiagnostics.label')}
            description={t('logging.sensitiveDiagnostics.description')}
            align="center"
          >
            <Switch
              checked={includeSensitiveDiagnostics}
              onChange={(e) => {
                void handleSensitiveDiagnosticsChange(e.target.checked);
              }}
              disabled={saving}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('logging.sections.path')}
            description={t('logging.path.description')}
            multiline
          >
            <div className="openbitfun-logging-config__path-row" data-openbitfun-component="application-settings" data-openbitfun-part="logPath">
              <Input
                className="openbitfun-logging-config__path-box"
                aria-label={t('logging.sections.path')}
                title={runtimeInfo?.sessionLogDir || undefined}
                value={runtimeInfo?.sessionLogDir || '-'}
                readOnly
                size="sm"
              />
              <Tooltip content={t('logging.actions.openFolderTooltip')} placement="top">
                <IconButton
                  aria-label={t('logging.actions.openFolderTooltip')}
                  variant="quiet"
                  size="sm"
                  onClick={handleOpenFolder}
                  loading={openingFolder}
                  disabled={openingFolder || !runtimeInfo?.sessionLogDir}
                  icon={<FolderOpen size={14} aria-hidden />}
                />
              </Tooltip>
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('logging.diagnostics.label')}
            description={t('logging.diagnostics.description')}
            align="center"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              leadingIcon={<Archive size={14} aria-hidden />}
              data-testid="diagnostics-export-button"
              onClick={() => {
                setExportConfirmOpen(true);
              }}
              loading={exportingDiagnostics}
              disabled={exportingDiagnostics}
            >
              {t('logging.actions.exportDiagnostics')}
            </Button>
          </ConfigPageRow>
        </ConfigPageSection>
        <ConfirmDialog
          open={exportConfirmOpen}
          onOpenChange={() => setExportConfirmOpen(false)}
          onConfirm={() => void handleExportDiagnostics()}
          title={t('logging.diagnostics.confirmTitle')}
          message={t(includeSensitiveDiagnostics
            ? 'logging.diagnostics.confirmSensitive'
            : 'logging.diagnostics.confirmStandard')}
          confirmText={t('logging.diagnostics.confirmAction')}
          type={includeSensitiveDiagnostics ? 'warning' : 'info'}
        />
      </div>
    </div>
  );
}

function TerminalSection() {
  const { t } = useTranslation('settings/application');
  const [defaultShell, setDefaultShell] = useState<string>('');
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showMessage = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);

      const [terminalConfig, shells] = await Promise.all([
        configManager.getConfig<TerminalSettings>('terminal'),
        getTerminalService().getAvailableShells(),
      ]);

      setDefaultShell(terminalConfig?.default_shell || '');

      const availableOnly = shells.filter((s) => s.available);
      setAvailableShells(availableOnly);
    } catch (error) {
      log.error('Failed to load terminal config data', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleShellChange = useCallback(
    async (value: string) => {
      const previous = defaultShell;
      try {
        setSaving(true);
        setDefaultShell(value);

        await configManager.setConfig('terminal.default_shell', value);

        configManager.clearCache();

        showMessage('success', t('terminal.messages.updated'));
      } catch (error) {
        setDefaultShell(previous);
        log.error('Failed to save terminal config', { shell: value, error });
        showMessage('error', t('terminal.messages.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [defaultShell, showMessage, t]
  );

  const shellOptions = useMemo<TerminalShellOption[]>(
    () => [
      { value: AUTO_DETECT_SHELL_VALUE, label: t('terminal.controls.autoDetect') },
      ...availableShells.map((shell) => ({
        description: shell.path,
        value: shell.path,
        label: formatShellLabel(shell),
        shell,
      })),
    ],
    [availableShells, t],
  );

  const selectedShell = useMemo(
    () =>
      availableShells.find((shell) => shell.path === defaultShell) ??
      availableShells.find((shell) => shell.shellType === defaultShell),
    [availableShells, defaultShell],
  );
  const selectedShellValue = selectedShell?.path ?? (defaultShell || AUTO_DETECT_SHELL_VALUE);

  const shouldShowCmdFallbackNotice = selectedShell?.shellType === 'Cmd' || defaultShell === 'Cmd';

  if (loading) {
    return <ConfigLoadingState label={t('terminal.messages.loading')} />;
  }

  if (loadFailed) {
    return (
      <ConfigRetryState
        message={t('terminal.messages.loadFailed')}
        retryLabel={t('common.retry')}
        onRetry={() => void loadData()}
      />
    );
  }

  return (
    <div className="openbitfun-terminal-config" data-openbitfun-component="application-settings" data-openbitfun-part="terminal">
      <div className="openbitfun-terminal-config__content">
        <ConfigMessage message={message} />

        {shouldShowCmdFallbackNotice && (
          <Alert
            tone="info"
            message={t('terminal.controls.cmdFallbackMessage')}
          />
        )}

        <ConfigPageSection
          title={t('terminal.sections.terminal')}
          description={t('terminal.sections.terminalHint')}
        >
          <ConfigPageRow
            label={t('terminal.sections.defaultTerminal')}
            description={t('terminal.controls.description')}
            align="center"
          >
            {availableShells.length > 0 ? (
              <Combobox
                size="sm"
                value={selectedShellValue}
                onValueChange={(v) => handleShellChange(v === AUTO_DETECT_SHELL_VALUE ? '' : v as string)}
                options={shellOptions}
                placeholder={t('terminal.controls.placeholder')}
                disabled={saving}
              />
            ) : (
              <div className="openbitfun-terminal-config__no-shells">{t('terminal.controls.noShells')}</div>
            )}
          </ConfigPageRow>

        </ConfigPageSection>
      </div>
    </div>
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

interface ApplicationSettingsPageProps {
  page: 'general' | 'terminal' | 'diagnostics';
}

const ApplicationSettingsPage: React.FC<ApplicationSettingsPageProps> = ({ page }) => {
  const { t } = useTranslation('settings');
  const { t: tApplication } = useTranslation('settings/application');
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  const title = t(`navigation.pages.${page}.label`);
  const subtitle = t(`navigation.pages.${page}.description`);

  return (
    <ConfigPageLayout
      className="openbitfun-application-settings"
      data-openbitfun-component="application-settings"
      data-openbitfun-part="root"
      data-openbitfun-view={page}
    >
      <ConfigPageHeader title={title} subtitle={subtitle} />
      <ConfigPageContent
        className="openbitfun-application-settings__content"
        data-openbitfun-component="application-settings"
        data-openbitfun-part="content"
      >
        {page === 'general' ? (
          <>
            {isTauri && (
              <ConfigPageSection
                title={tApplication('applicationGroups.startupAndUpdates.title')}
                description={tApplication('applicationGroups.startupAndUpdates.description')}
              >
                <LaunchAtLoginSetting />
                <PreventSleepSetting />
                <AutoUpdateSetting />
              </ConfigPageSection>
            )}
            <ConfigPageSection
              title={tApplication('applicationGroups.windowAndNotifications.title')}
              description={tApplication('applicationGroups.windowAndNotifications.description')}
            >
              <WindowBehaviorSetting />
              <NotificationSettings />
            </ConfigPageSection>
          </>
        ) : null}
        {page === 'terminal' ? <TerminalSection /> : null}
        {page === 'diagnostics' ? <LoggingSection /> : null}
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export function GeneralSettingsPage(): React.ReactElement {
  return <ApplicationSettingsPage page="general" />;
}

export function TerminalSettingsPage(): React.ReactElement {
  return <ApplicationSettingsPage page="terminal" />;
}

export function DiagnosticsSettingsPage(): React.ReactElement {
  return <ApplicationSettingsPage page="diagnostics" />;
}
