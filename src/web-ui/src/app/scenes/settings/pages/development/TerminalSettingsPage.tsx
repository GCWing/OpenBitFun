import '@/app/scenes/settings/pages/shared/ApplicationSettings.scss';
import { ConfigLoadingState, ConfigMessage, ConfigPageRow, ConfigPageSection, ConfigRetryState } from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  TerminalConfig as TerminalSettings
} from '@/infrastructure/config/types';
import { createLogger } from '@/shared/utils/logger';
import { getTerminalService } from '@/tools/terminal/services';
import type { ShellInfo } from '@/tools/terminal/types/session';
import { Combobox, type ComboboxOption } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '../shared/SettingsPage';
const log = createLogger('TerminalSettingsPage');

const AUTO_DETECT_SHELL_VALUE = '__auto_detect_shell__';

type TerminalShellOption = ComboboxOption & {
  shell?: ShellInfo;
};

const formatShellLabel = (shell: ShellInfo): string =>
  `${shell.name}${shell.version ? ` (${shell.version})` : ''}`;

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

        <ConfigPageSection
          title={t('terminal.sections.terminal')}
          description={shouldShowCmdFallbackNotice
            ? t('terminal.sections.terminalHintWithCmdFallback')
            : t('terminal.sections.terminalHint')}
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
const TerminalSettingsPage: React.FC = () => {

  return <SettingsPage pageId="development.terminal" data-openbitfun-component="application-settings" data-openbitfun-part="root"><TerminalSection /></SettingsPage>;
};
export default TerminalSettingsPage;
