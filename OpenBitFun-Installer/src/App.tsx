import { useLayoutEffect, useRef } from 'react';
import { DesignSystemProvider, Select } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { WindowControls } from './components/WindowControls';
import { StepIndicator } from './components/StepIndicator';
import { OpenBitFunAppIcon } from '@openbitfun/ui/brand';
import { LanguageSelect } from './pages/LanguageSelect';
import { Options } from './pages/Options';
import { ModelSetup } from './pages/ModelSetup';
import { ProgressPage } from './pages/Progress';
import { ThemeSetup } from './pages/ThemeSetup';
import { UninstallPage } from './pages/Uninstall';
import { useInstaller } from './hooks/useInstaller';
import type { InstallStep } from './types/installer';
import {
  DEFAULT_INSTALLER_UI_LANGUAGE,
  mapUiLanguageToAppLanguage,
  resolveInstallerUiLanguage,
  type InstallerUiLanguage,
} from './i18n/languages';
import { useSyncInstallerRootTheme } from './theme/installerThemeRuntime';
import './styles/global.css';

function App() {
  const installer = useInstaller();
  useSyncInstallerRootTheme(installer.options.themePreference);
  const { t, i18n } = useTranslation();
  const pageRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const language = resolveInstallerUiLanguage(i18n.resolvedLanguage ?? i18n.language)
      ?? DEFAULT_INSTALLER_UI_LANGUAGE;
    document.documentElement.lang = mapUiLanguageToAppLanguage(language);
  }, [i18n.language]);

  useLayoutEffect(() => {
    pageRef.current?.focus({ preventScroll: true });
  }, [installer.step]);

  const handleLanguageSelect = (lang: InstallerUiLanguage) => {
    i18n.changeLanguage(lang);
    installer.setOptions((prev) => ({
      ...prev,
      appLanguage: mapUiLanguageToAppLanguage(lang),
    }));
    installer.next();
  };

  const renderPage = () => {
    switch (installer.step) {
      case 'lang':
        return <LanguageSelect onSelect={handleLanguageSelect} />;
      case 'options':
        return (
          <Options
            options={installer.options}
            setOptions={installer.setOptions}
            diskSpace={installer.diskSpace}
            error={installer.error}
            refreshDiskSpace={installer.refreshDiskSpace}
            existingInstall={installer.existingInstall}
            onLaunchRegisteredUninstaller={installer.launchRegisteredUninstaller}
            onBack={installer.back}
            onInstall={installer.install}
            isInstalling={installer.isInstalling}
            clearInstallError={installer.clearInstallError}
            previewOnly={installer.previewOnly}
          />
        );
      case 'model':
        return (
          <ModelSetup
            options={installer.options}
            setOptions={installer.setOptions}
            onSkip={installer.next}
            onTestConnection={installer.testModelConnection}
            previewOnly={installer.previewOnly}
            onNext={async () => {
              if (!installer.previewOnly) await installer.saveModelConfig();
              installer.next();
            }}
          />
        );
      case 'progress':
        return (
          <ProgressPage
            progress={installer.progress}
            error={installer.error}
            canConfirmProgress={installer.canConfirmProgress}
            onConfirmProgress={installer.confirmProgress}
            onRetry={installer.retryInstall}
            onBackToOptions={installer.backToOptions}
          />
        );
      case 'theme':
        return (
          <ThemeSetup
            options={installer.options}
            setOptions={installer.setOptions}
            onLaunch={installer.launchApp}
            onClose={installer.closeInstaller}
            previewOnly={installer.previewOnly}
          />
        );
      case 'uninstall':
        return (
          <UninstallPage
            installPath={installer.options.installPath}
            isUninstalling={installer.isUninstalling}
            uninstallCompleted={installer.uninstallCompleted}
            uninstallError={installer.uninstallError}
            uninstallProgress={installer.uninstallProgress}
            onUninstall={installer.startUninstall}
            onClose={installer.closeInstaller}
            previewOnly={installer.previewOnly}
          />
        );
      default:
        return null;
    }
  };

  return (
    <DesignSystemProvider
      locale={i18n.language}
      messages={{ noOptions: t('model.modelNoResults'), selectPlaceholder: t('model.selectProvider') }}
    >
      <div className="installer-app">
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-brand" data-tauri-drag-region>
            <OpenBitFunAppIcon size={16} data-tauri-drag-region />
            <span className="titlebar-title" data-tauri-drag-region>{t('shared.product.name')}</span>
          </div>
          {installer.previewOnly && (
            <div className="installer-preview-controls">
              <span>{t('preview.badge')}</span>
              <Select
                size="sm"
                aria-label={t('preview.page')}
                value={installer.step}
                onValueChange={(value) => installer.goTo(value as InstallStep)}
                options={[
                  { value: 'lang', label: t('steps.language') },
                  { value: 'options', label: t('options.title') },
                  { value: 'progress', label: t('preview.progress') },
                  { value: 'model', label: t('model.title') },
                  { value: 'theme', label: t('themeSetup.title') },
                  { value: 'uninstall', label: t('uninstall.title') },
                ]}
              />
            </div>
          )}
          <WindowControls />
        </div>

        {installer.step !== 'lang' && installer.step !== 'uninstall' && (
          <StepIndicator step={installer.step} />
        )}

        <main className="installer-content" key={installer.step} ref={pageRef} tabIndex={-1}>
          {renderPage()}
        </main>
      </div>
    </DesignSystemProvider>
  );
}

export default App;
