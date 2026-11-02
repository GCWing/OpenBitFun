import { useLayoutEffect, useRef } from 'react';
import type { MiniApp } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useI18n } from '@/infrastructure/i18n';
import { isMacOSDesktopRuntime, isWindowsDesktopRuntime } from '@/infrastructure/runtime';
import { mountTitlebar } from '../../../../../../shared/miniapp-chrome/titlebar';
import icons from '../../../../../../shared/miniapp-chrome/icons.generated.json';
import '../../../../../../shared/miniapp-chrome/titlebar.css';
import { pickLocalizedString } from '../utils/pickLocalizedString';

/** Uses the exact native-shell renderer, with window actions inert in a draft. */
export function MiniAppTitlebarPreview({ app }: { app: MiniApp }) {
  const ref = useRef<HTMLDivElement>(null);
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  useLayoutEffect(() => {
    if (!ref.current) return;
    const bar = mountTitlebar(ref.current, {
      chrome: app.chrome, title: pickLocalizedString(app, currentLanguage, 'name'),
      icon: app.icon, icons, locale: currentLanguage, preview: true,
      platform: isMacOSDesktopRuntime() ? 'macos' : isWindowsDesktopRuntime() ? 'windows' : 'linux',
      labels: {
        titlebar: t('presentation.titlebar'), openTab: t('presentation.openTab'),
        minimize: t('presentation.minimize'), maximize: t('presentation.maximize'),
        restore: t('presentation.restore'), close: t('presentation.close'),
      },
    });
    return () => bar.destroy();
  }, [app, currentLanguage, t]);
  return <div ref={ref} data-openbitfun-scene="miniapp" data-openbitfun-part="titlebar" />;
}
