import { NavigationTransitionBoundary } from '@/app/navigation/NavigationTransitionBoundary';
import {
  cancelPendingSettingsNavigation,
  discardAndContinueSettingsNavigation,
  saveAndContinueSettingsNavigation,
  useSettingsDraftSnapshot,
} from '@/infrastructure/config/settingsDraftRegistry';
import { ConfirmDialog } from '@openbitfun/ui';
import React, { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getSettingsPageManifest,
  isSettingsPageReady,
  preloadSettingsPage,
} from './settingsRegistry';
import './SettingsScene.scss';
import { useSettingsStore } from './settingsStore';
import type { SettingsPageId } from './settingsTypes';

function SettingsSceneLoading() {
  return (
    <div
      className="openbitfun-settings-scene__loading"
      aria-busy="true"
      aria-hidden="true"
      data-openbitfun-scene="settings"
      data-openbitfun-part="loading"
    >
      <div className="openbitfun-settings-scene__loading-line openbitfun-settings-scene__loading-line--title" />
      <div className="openbitfun-settings-scene__loading-line" />
      <div className="openbitfun-settings-scene__loading-line" />
      <div className="openbitfun-settings-scene__loading-block" />
    </div>
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
  const pageTransitionTarget = useSettingsStore((state) => state.pageTransitionTarget);
  const pageTransitionMotion = useSettingsStore((state) => state.pageTransitionMotion);
  const pageTransitionSequence = useSettingsStore((state) => state.pageTransitionSequence);
  const { pendingNavigation } = useSettingsDraftSnapshot();
  const appliedTransitionSequenceRef = useRef(pageTransitionSequence);
  const [preparedPageId, setPreparedPageId] = useState<SettingsPageId | null>(() => (
    isSettingsPageReady(activePageId) ? activePageId : null
  ));

  useEffect(() => {
    if (isSettingsPageReady(activePageId)) {
      setPreparedPageId(activePageId);
      return;
    }
    let cancelled = false;
    const commit = () => {
      if (!cancelled) setPreparedPageId(activePageId);
    };
    void preloadSettingsPage(activePageId).then(commit, commit);
    return () => {
      cancelled = true;
    };
  }, [activePageId]);

  const shouldAnimatePageTransition = (
    appliedTransitionSequenceRef.current !== pageTransitionSequence
    && pageTransitionTarget === activePageId
    && pageTransitionMotion === 'pointer'
  );

  useLayoutEffect(() => {
    appliedTransitionSequenceRef.current = pageTransitionSequence;
  }, [pageTransitionSequence]);

  const manifest = getSettingsPageManifest(activePageId);
  const Content = preparedPageId === activePageId ? manifest.component : null;

  return (
    <div
      className="openbitfun-settings-scene"
      data-testid="settings-scene"
      data-settings-page={activePageId}
      data-openbitfun-scene="settings"
      data-openbitfun-part="root"
      data-openbitfun-page={activePageId}
    >
      {Content ? (
        <NavigationTransitionBoundary
          transitionKey={activePageId}
          motion={shouldAnimatePageTransition ? 'pointer' : 'none'}
          className="openbitfun-settings-scene__content-transition"
          layerClassName="openbitfun-settings-scene__content-wrapper"
        >
          <div
            data-testid="settings-scene-content"
            data-openbitfun-scene="settings"
            data-openbitfun-part="content"
            data-openbitfun-page={activePageId}
          >
            <Suspense fallback={<SettingsSceneLoading />}>
              <Content
                isActive={isActive}
                viewId={activeViewId ?? undefined}
                sectionId={activeSectionId ?? undefined}
                navigationRequestId={navigationRequestId}
              />
            </Suspense>
          </div>
        </NavigationTransitionBoundary>
      ) : <SettingsSceneLoading />}
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
