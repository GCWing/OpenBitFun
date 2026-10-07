import '@/app/scenes/settings/pages/shared/ApplicationSettings.scss';
import { configAPI, workspaceAPI } from '@/infrastructure/api';
import { ConfigLoadingState, ConfigMessage, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  BackendLogLevel,
  RuntimeLoggingInfo
} from '@/infrastructure/config/types';
import { createLogger } from '@/shared/utils/logger';
import { Alert, Button, ConfirmDialog, IconButton, Input, Select, Switch, Tooltip } from '@openbitfun/ui';
import { Archive, FolderOpen } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const log = createLogger('DiagnosticsSettingsPage');

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
const DiagnosticsSettingsPage: React.FC = () => {

  return <SettingsPage pageId="data.diagnostics" data-openbitfun-component="application-settings" data-openbitfun-part="root"><LoggingSection /></SettingsPage>;
};
export default DiagnosticsSettingsPage;
