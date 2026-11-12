import { IconButton } from '@openbitfun/ui';
import { Minus as LucideMinus, X as LucideX } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';

/**
 * Window controls — matches the OpenBitFun main app style.
 * 32x32 transparent buttons with SVG icons, subtle hover bg.
 */
export function WindowControls({ busy = false }: { busy?: boolean }) {
  const { t } = useTranslation();
  const handleMinimize = () => {
    getCurrentWindow().minimize();
  };

  const handleClose = () => {
    if (busy) return;
    getCurrentWindow().close();
  };

  return (
    <div className="window-controls">
      <IconButton
        className="window-controls__btn"
        onClick={handleMinimize}
        aria-label={t('window.minimize')}
        title={t('window.minimize')}
        icon={<LucideMinus width="14" height="14" aria-hidden="true" />}
      />
      <IconButton
        className="window-controls__btn window-controls__btn--close"
        disabled={busy}
        onClick={handleClose}
        aria-label={t('window.close')}
        title={t('window.close')}
        icon={<LucideX width="14" height="14" aria-hidden="true" />}
      />
    </div>
  );
}
