import { useConfigSeed } from '@/infrastructure/config/hooks/useConfigSeed';
import { createSettingsReadCache } from '@/infrastructure/config/services/SettingsReadCache';
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const loggingRuntime = createSettingsReadCache<RuntimeLoggingInfo>();

const log = createLogger('DiagnosticsSettingsPage');

function LoggingSection() {
  const { t } = useTranslation('settings/application');
  const seed = useConfigSeed(['app.logging.level', 'app.logging.include_sensitive_diagnostics']);
  const [cachedRuntime] = useState(() => loggingRuntime.peek());
  const editRevision = useRef(0);
  const hasLoaded = useRef(seed.loaded && cachedRuntime !== undefined);
  const [configLevel, setConfigLevel] = useState<BackendLogLevel>(seed.get<BackendLogLevel | null>('app.logging.level', null) ?? cachedRuntime?.effectiveLevel ?? 'info');
  const [includeSensitiveDiagnostics, setIncludeSensitiveDiagnostics] = useState(seed.get('app.logging.include_sensitive_diagnostics', false) ?? false);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeLoggingInfo | null>(cachedRuntime ?? null);
  const [loading, setLoading] = useState(!hasLoaded.current);
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
    const revision = editRevision.current;
    try {
      setLoading(!hasLoaded.current);
      setLoadFailed(false);

      const [savedLevel, savedIncludeSensitiveDiagnostics, info] = await Promise.all([
        configManager.getConfig<BackendLogLevel>('app.logging.level'),
        configManager.getConfig<boolean>('app.logging.include_sensitive_diagnostics'),
        loggingRuntime.read(() => configAPI.getRuntimeLoggingInfo()),
      ]);

      if (revision === editRevision.current) {
        setConfigLevel(savedLevel || info.effectiveLevel || 'info');
        setIncludeSensitiveDiagnostics(savedIncludeSensitiveDiagnostics ?? false);
      }
      setRuntimeInfo(info);
      hasLoaded.current = true;
    } catch (error) {
      log.error('Failed to load logging config', error);
      setLoadFailed(true);
      if (hasLoaded.current) setMessage({ type: 'error', text: t('logging.messages.loadFailed') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleLevelChange = useCallback(
    async (value: string) => {
      editRevision.current += 1;
      const nextLevel = value as BackendLogLevel;
      const previousLevel = configLevel;
      setConfigLevel(nextLevel);
      setSaving(true);

      try {
        await configManager.setConfig('app.logging.level', nextLevel);

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
      editRevision.current += 1;
      const previousValue = includeSensitiveDiagnostics;
      setIncludeSensitiveDiagnostics(checked);
      setSaving(true);

      try {
        await configManager.setConfig('app.logging.include_sensitive_diagnostics', checked);
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

  if (loadFailed && !hasLoaded.current) {
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

        {runtimeInfo?.previousUnexpectedExit?.detected && runtimeInfo.previousUnexpectedExit.category === 'crash' && (
          <Alert
            tone="warning"
            message={t('logging.previousCrash.title')}
            description={t('logging.previousCrash.description', {
              path: runtimeInfo.previousUnexpectedExit.sessionLogDir || '-',
            })}
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
