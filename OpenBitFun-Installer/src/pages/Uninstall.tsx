import { Button, PageHeader } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../components/BrandMark';
import { ProgressBar } from '../components/ProgressBar';
import { InstallErrorPanel } from '../components/InstallErrorPanel';

interface UninstallPageProps {
  previewOnly?: boolean;
  installPath: string;
  isUninstalling: boolean;
  uninstallCompleted: boolean;
  uninstallError: string | null;
  uninstallProgress: number;
  onUninstall: () => Promise<void>;
  onClose: () => void;
}

export function UninstallPage({
  installPath,
  isUninstalling,
  uninstallCompleted,
  uninstallError,
  uninstallProgress,
  onUninstall,
  onClose,
  previewOnly = false,
}: UninstallPageProps) {
  const { t } = useTranslation();

  return (
    <div className="page-shell">
      <div className="page-scroll">
        <div className="page-container page-container--center uninstall-content">
          <BrandMark />
          <PageHeader className="page-heading" title={t('uninstall.title')} description={t('uninstall.subtitle')} />
          <div className="uninstall-location">
            <span className="section-label">{t('uninstall.installPath')}</span>
            <span className="selectable-path">{installPath || t('uninstall.pathUnknown')}</span>
          </div>
          {uninstallError && <InstallErrorPanel message={uninstallError} variant="bare" />}
          {uninstallCompleted && <p className="status-success" role="status">{t('uninstall.completed')}</p>}
          {(isUninstalling || uninstallCompleted) && (
            <div className="uninstall-progress">
              <ProgressBar percent={uninstallProgress} completed={uninstallCompleted} label={t('uninstall.uninstalling')} />
              <span className="progress-percent">{uninstallProgress}%</span>
            </div>
          )}
        </div>
      </div>

      <div className="page-footer">
        <Button variant={uninstallCompleted ? 'primary' : 'fill'} disabled={isUninstalling} onClick={onClose}>
          {t(uninstallCompleted ? 'uninstall.close' : 'uninstall.cancel')}
        </Button>
        {!uninstallCompleted && (
          <Button tone="danger" disabled={previewOnly} loading={isUninstalling} onClick={() => { void onUninstall(); }}>
            {isUninstalling ? t('uninstall.uninstalling') : t('uninstall.confirm')}
          </Button>
        )}
      </div>
    </div>
  );
}
