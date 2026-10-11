import {
  cancelPendingSettingsNavigation,
  discardAndContinueSettingsNavigation,
  saveAndContinueSettingsNavigation,
  useSettingsDraftSnapshot,
} from '@/infrastructure/config/settingsDraftRegistry';
import { ConfirmDialog } from '@openbitfun/ui';
import React, { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { ConfigLoadingState, ConfigRetryState } from '@/infrastructure/config/components/common';
import { SettingsPage } from './pages/shared/SettingsPage';
import { useSettingsScrollRestoration } from './useSettingsScrollRestoration';
import { useTranslation } from 'react-i18next';
import {
  getSettingsPageManifest,
  isSettingsPageReady,
  preloadSettingsPage,
} from './settingsRegistry';
import './SettingsScene.scss';
import { useSettingsStore } from './settingsStore';
import type { SettingsPageId } from './settingsTypes';

function SettingsSceneLoading({ pageId }: { pageId: SettingsPageId }) {
  const { t } = useTranslation('common');
  return (
    <SettingsPage pageId={pageId} data-openbitfun-scene="settings" data-openbitfun-part="loading">
      <ConfigLoadingState label={t('app.loading')} rows={5} />
    </SettingsPage>
  );
}

interface SettingsSceneProps {
  isActive?: boolean;
}

const SettingsScene: React.FC<SettingsSceneProps> = ({ isActive = true }) => {
  const { t } = useTranslation('settings');
  const activePageId = useSettingsStore((state) => state.activePageId);
  const activeViewId = useSettingsStore((state) => state.activeViewId);
  const activeSectionId = useSettingsStore((state) => state.activeSectionId);
  const navigationRequestId = useSettingsStore((state) => state.navigationRequestId);
  const { pendingNavigation } = useSettingsDraftSnapshot();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const contentRef = useRef<HTMLDivElement>(null);
  const [preparation, setPreparation] = useState<{ pageId: SettingsPageId; error: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const { t: tErrors } = useTranslation('errors');
  const ready = isSettingsPageReady(activePageId)
    || (preparation?.pageId === activePageId && !preparation.error);
  const failed = !ready && preparation?.pageId === activePageId && preparation.error;

  useEffect(() => {
    if (isSettingsPageReady(activePageId)) return;
    let cancelled = false;
    void preloadSettingsPage(activePageId).then(
      () => { if (!cancelled) setPreparation({ pageId: activePageId, error: false }); },
      () => { if (!cancelled) setPreparation({ pageId: activePageId, error: true }); },
    );
    return () => { cancelled = true; };
  }, [activePageId, retry]);

  useSettingsScrollRestoration(contentRef, activePageId, scope.epoch, ready, activeSectionId, navigationRequestId);
  const manifest = getSettingsPageManifest(activePageId);
  const Content = manifest.resolvedComponent ?? manifest.component;

  return (
    <div
      className="openbitfun-settings-scene"
      data-testid="settings-scene"
      data-settings-page={activePageId}
      data-openbitfun-scene="settings"
      data-openbitfun-part="root"
      data-openbitfun-page={activePageId}
    >
      <div ref={contentRef} className="openbitfun-settings-scene__content-wrapper">
        <div
          key={`${scope.epoch}:${activePageId}`}
          data-testid="settings-scene-content"
          data-openbitfun-scene="settings"
          data-openbitfun-part="content"
          data-openbitfun-page={activePageId}
        >
          {failed ? (
            <SettingsPage pageId={activePageId}>
              <ConfigRetryState
                message={tErrors('moduleLoad.description')}
                retryLabel={tErrors('moduleLoad.retry')}
                onRetry={() => { setPreparation(null); setRetry(value => value + 1); }}
              />
            </SettingsPage>
          ) : ready ? (
            <Suspense fallback={<SettingsSceneLoading pageId={activePageId} />}>
              <Content
                isActive={isActive}
                viewId={activeViewId ?? undefined}
                sectionId={activeSectionId ?? undefined}
                navigationRequestId={navigationRequestId}
              />
            </Suspense>
          ) : <SettingsSceneLoading pageId={activePageId} />}
        </div>
      </div>
      <ConfirmDialog
        open={pendingNavigation !== null}
        testId="settings-unsaved-navigation-dialog"
        title={t('changeGuard.title')}
        message={pendingNavigation?.failed
          ? t('changeGuard.saveFailed')
          : t('changeGuard.message', {
            count: pendingNavigation?.resourceLabels.length ?? 0,
          })}
        preview={pendingNavigation?.resourceLabels.length ? (
          <ul className="openbitfun-settings-scene__draft-list">
            {pendingNavigation.resourceLabels.map((label, index) => (
              <li key={`${label}:${index}`}>{label}</li>
            ))}
          </ul>
        ) : undefined}
        cancelText={t('changeGuard.keepEditing')}
        secondaryText={t('changeGuard.discardAndLeave')}
        confirmText={t('changeGuard.saveAndLeave')}
        pendingAction={pendingNavigation?.action === 'save'
          ? 'confirm'
          : pendingNavigation?.action === 'discard'
            ? 'secondary'
            : null}
        onOpenChange={() => cancelPendingSettingsNavigation()}
        onSecondary={async () => {
          await discardAndContinueSettingsNavigation();
        }}
        onConfirm={async () => {
          await saveAndContinueSettingsNavigation();
        }}
        closeOnPointerOutside={false}
        type={pendingNavigation?.failed ? 'error' : 'warning'}
      />
    </div>
  );
};

export default SettingsScene;
