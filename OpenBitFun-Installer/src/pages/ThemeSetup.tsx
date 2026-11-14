import { Button, Checkbox, PageHeader, Radio } from '@openbitfun/ui';
import { ArrowUpRight, Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { InstallOptions, ThemePreferenceId } from '../types/installer';
import { SYSTEM_THEME_ID } from '../types/installer';
import { THEMES, THEME_DISPLAY_ORDER } from '../theme/installerThemesData';

interface ThemeSetupProps {
  previewOnly?: boolean;
  options: InstallOptions;
  setOptions: React.Dispatch<React.SetStateAction<InstallOptions>>;
  onLaunch: () => Promise<void>;
  onClose: () => void;
}

export function ThemeSetup({ options, setOptions, onLaunch, onClose, previewOnly = false }: ThemeSetupProps) {
  const { t } = useTranslation();
  const [isFinishing, setIsFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const orderedThemes = [...THEMES].sort((a, b) => THEME_DISPLAY_ORDER.indexOf(a.id) - THEME_DISPLAY_ORDER.indexOf(b.id));

  const selectTheme = (theme: ThemePreferenceId) => {
    setOptions((prev) => ({ ...prev, themePreference: theme }));
  };

  const handleFinish = async () => {
    if (isFinishing) return;
    if (previewOnly) {
      onClose();
      return;
    }
    setIsFinishing(true);
    setFinishError(null);

    try {
      await invoke('set_theme_preference', { themePreference: options.themePreference });

      if (options.launchAfterInstall) {
        await onLaunch();
      }
      onClose();
    } catch (err: unknown) {
      setFinishError(typeof err === 'string' ? err : (err as Error)?.message || 'Failed to launch OpenBitFun');
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="page-shell">
      <div className="page-scroll">
        <div className="page-container">
          <PageHeader className="page-heading" title={t('themeSetup.title')} description={t('themeSetup.subtitle')} />

          <fieldset className="theme-options" aria-label={t('themeSetup.title')} disabled={isFinishing}>
            <Radio
              className="theme-system"
              name="installer-theme"
              value={SYSTEM_THEME_ID}
              checked={options.themePreference === SYSTEM_THEME_ID}
              disabled={isFinishing}
              label={t('themeSetup.followSystem')}
              onCheckedChange={(checked) => { if (checked) selectTheme(SYSTEM_THEME_ID); }}
            />
            <div className="theme-grid">
              {orderedThemes.map((theme) => (
                <Radio
                  className="theme-option"
                  key={theme.id}
                  name="installer-theme"
                  value={theme.id}
                  checked={options.themePreference === theme.id}
                  disabled={isFinishing}
                  onCheckedChange={(checked) => { if (checked) selectTheme(theme.id); }}
                  label={
                    <span className="theme-option__label">
                      <span>{t(`themeSetup.themeNames.${theme.id}`, { defaultValue: theme.name })}</span>
                      <span className="theme-palette" aria-hidden="true">
                        <span style={{ background: theme.colors.background.primary }} />
                        <span style={{ background: theme.colors.background.secondary }} />
                        <span style={{ background: theme.colors.accent }} />
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          </fieldset>

          {finishError && <p className="finish-error status-danger" role="alert">{finishError}</p>}
        </div>
      </div>

      <div className="page-footer page-footer--split">
        <Checkbox
          checked={options.launchAfterInstall}
          disabled={isFinishing}
          onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, launchAfterInstall: checked }))}
          label={t('options.launchAfterInstall')}
        />
        <Button
          variant="primary"
          trailingIcon={options.launchAfterInstall ? <ArrowUpRight /> : <Check />}
          onClick={handleFinish}
          loading={isFinishing}
        >
          {t('complete.finish')}
        </Button>
      </div>
    </div>
  );
}
