import { Button, Checkbox, Disclosure, Field, Input, PageHeader } from '@openbitfun/ui';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { installPathApi } from '../infrastructure/installPathApi';
import { InstallErrorPanel } from '../components/InstallErrorPanel';
import type {
  InstallOptions,
  DiskSpaceInfo,
  ExistingInstallation,
} from '../types/installer';

interface OptionsProps {
  previewOnly?: boolean;
  options: InstallOptions;
  setOptions: React.Dispatch<React.SetStateAction<InstallOptions>>;
  diskSpace: DiskSpaceInfo | null;
  error: string | null;
  refreshDiskSpace: (path: string) => Promise<void>;
  existingInstall: ExistingInstallation | null;
  onLaunchRegisteredUninstaller: () => void | Promise<void>;
  onBack: () => void;
  onInstall: () => Promise<void>;
  isInstalling: boolean;
  clearInstallError: () => void;
}

export function Options({
  options,
  setOptions,
  diskSpace,
  error,
  refreshDiskSpace,
  existingInstall,
  onLaunchRegisteredUninstaller,
  onBack,
  onInstall,
  isInstalling,
  clearInstallError,
  previewOnly = false,
}: OptionsProps) {
  const { t } = useTranslation();
  const pathOperation = useRef(false);
  const [isSelectingPath, setIsSelectingPath] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const shownError = error ?? pathError;
  const busy = isInstalling || isSelectingPath;
  const existingTarget = Boolean(existingInstall?.detected && existingInstall.installLocation === options.installPath);

  useEffect(() => {
    if (options.installPath) refreshDiskSpace(options.installPath);
  }, [options.installPath, refreshDiskSpace]);

  const handleBrowse = async () => {
    if (pathOperation.current) return;
    pathOperation.current = true;
    setIsSelectingPath(true);
    setPathError(null);
    try {
      const selected = await installPathApi.chooseDirectory(options.installPath, t('options.pathLabel'));
      if (selected && typeof selected === 'string') {
        const validated = await installPathApi.validate(selected);
        setOptions((prev) => ({ ...prev, installPath: validated.installPath }));
        clearInstallError();
      }
    } catch (error) { setPathError(String(error)); }
    finally { pathOperation.current = false; setIsSelectingPath(false); }
  };

  const changeScope = async (allUsers: boolean) => {
    if (pathOperation.current) return;
    pathOperation.current = true;
    setIsSelectingPath(true);
    setPathError(null);
    try {
      const installPath = await installPathApi.defaultPath(allUsers);
      setOptions(previous => ({ ...previous, allUsers, installPath }));
      clearInstallError();
    } catch (error) { setPathError(String(error)); }
    finally { pathOperation.current = false; setIsSelectingPath(false); }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  return (
    <div className="page-shell">
      <div className="page-scroll">
        <div className="page-container">
          <PageHeader className="page-heading" title={t('options.title')} />

          {existingInstall?.detected && (
            <Disclosure
              className="existing-install"
              summary={t(existingInstall.mainBinaryPresent ? 'options.existingInstallTitle' : 'options.existingInstallBinaryMissing')}
            >
              <div className="existing-install__details">
                {existingInstall.displayVersion && (
                  <p>{t('options.existingInstallVersion', { version: existingInstall.displayVersion })}</p>
                )}
                {existingInstall.installLocation && (
                  <p className="selectable-path">{t('options.existingInstallLocation', { path: existingInstall.installLocation })}</p>
                )}
                {existingInstall.uninstallString && (
                  <Button variant="text" size="sm" disabled={busy || previewOnly} onClick={() => { void onLaunchRegisteredUninstaller(); }}>
                    {t('options.existingInstallRunUninstaller')}
                  </Button>
                )}
              </div>
            </Disclosure>
          )}

          <section className="install-location">
            <Field
              label={t('options.pathLabel')}
              controlWidth="fill"
              controlTrailing={
                <Button variant="fill" disabled={busy || previewOnly} onClick={handleBrowse}>{t('options.browse')}</Button>
              }
            >
              <Input
                size="md"
                className="path-input"
                value={options.installPath}
                disabled={busy}
                invalid={!!shownError}
                aria-describedby={diskSpace ? 'install-disk-space' : undefined}
                onChange={(event) => {
                  setOptions((prev) => ({ ...prev, installPath: event.target.value }));
                  clearInstallError();
                  setPathError(null);
                }}
                placeholder={t('options.pathPlaceholder')}
                spellCheck={false}
              />
            </Field>
            {diskSpace && (
              <div className="disk-space" id="install-disk-space">
                <span>{t('options.required')}: {formatBytes(diskSpace.required)}</span>
                <span>
                  {t('options.available')}: {diskSpace.available < Number.MAX_SAFE_INTEGER ? formatBytes(diskSpace.available) : '—'}
                </span>
                {!diskSpace.sufficient && <span className="status-danger">{t('options.insufficientSpace')}</span>}
              </div>
            )}
            {shownError && <InstallErrorPanel message={shownError} variant="options" />}
          </section>

          <fieldset className="install-options">
            <legend className="section-label">{t('options.optionsLabel')}</legend>
            <Checkbox
              checked={options.desktopShortcut}
              disabled={isInstalling}
              onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, desktopShortcut: checked }))}
              label={t('options.desktopShortcut')}
            />
            <Checkbox
              checked={options.startMenu}
              disabled={isInstalling}
              onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, startMenu: checked }))}
              label={t('options.startMenu')}
            />
            <Checkbox
              checked={existingTarget ? existingInstall?.source === 'uninstall_hklm' : options.allUsers === true}
              disabled={busy || previewOnly || existingTarget}
              onCheckedChange={(checked) => { void changeScope(checked); }}
              label={t('options.allUsers')}
            />
          </fieldset>
        </div>
      </div>

      <div className="page-footer page-footer--split">
        <Button variant="text" disabled={busy} onClick={onBack}>
          {t('options.changeLanguage')}
        </Button>
        <Button
          variant="primary"
          trailingIcon={<ArrowRight />}
          loading={isInstalling}
          onClick={() => { if (!pathOperation.current) void onInstall(); }}
          disabled={busy || previewOnly || !options.installPath || (diskSpace !== null && !diskSpace.sufficient)}
        >
          {isInstalling ? t('options.installing') : t('options.install')}
        </Button>
      </div>
    </div>
  );
}
