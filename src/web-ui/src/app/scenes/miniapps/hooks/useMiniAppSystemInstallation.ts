import { useState } from 'react';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppPresentationAPI } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNotification } from '@/shared/notification-system';
import { pickLocalizedString } from '../utils/pickLocalizedString';
import { renderMiniAppSystemIcon } from '../utils/miniAppSystemIcon';

/** Notifications follow the operation even when its initiating view closes. */
export function useMiniAppSystemInstallation(supported: boolean) {
  const [scope] = useState(getActiveSurfaceScope);
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  const notification = useNotification();

  const run = async <T,>(
    action: () => Promise<T>,
    messages: { title: string; pending: string; completed: (result: T) => string; failed: (error: string) => string },
  ): Promise<T | undefined> => {
    if (!supported || !scope.isCurrent()) return;
    const progress = notification.progress({
      title: messages.title,
      message: messages.pending,
      progressMode: 'text-only',
    });
    // A device switch must also clear progress, even if the old host never replies.
    const dismiss = () => progress.cancel();
    scope.signal.addEventListener('abort', dismiss, { once: true });
    try {
      const result = await action();
      if (!scope.isCurrent()) return;
      progress.complete(messages.completed(result));
      return result;
    } catch (error) {
      if (scope.isCurrent()) progress.fail(messages.failed(String(error)));
    } finally {
      scope.signal.removeEventListener('abort', dismiss);
    }
  };

  return {
    install: (app: MiniAppMeta, workspacePath?: string | null, update = false) => {
      const name = pickLocalizedString(app, currentLanguage, 'name');
      return run(
        () => miniAppPresentationAPI.install(app.id, workspacePath, renderMiniAppSystemIcon(app.icon)),
        {
          title: update ? t('presentation.updateInstallation') : t('presentation.install'),
          pending: update ? t('presentation.updating', { name }) : t('presentation.installing', { name }),
          completed: ({ path }) => update
            ? t('presentation.updated', { name, path })
            : t('presentation.installed', { name, path }),
          failed: error => update
            ? t('presentation.updateFailed', { name, error })
            : t('presentation.installFailed', { name, error }),
        },
      );
    },
    uninstall: (app: MiniAppMeta) => {
      const name = pickLocalizedString(app, currentLanguage, 'name');
      return run(
        async () => { await miniAppPresentationAPI.uninstall(app.id); return true; },
        {
          title: t('presentation.uninstall'),
          pending: t('presentation.uninstalling', { name }),
          completed: () => t('presentation.uninstalled', { name }),
          failed: error => t('presentation.uninstallFailed', { name, error }),
        },
      );
    },
  };
}
