/**
 * MiniAppScene — standalone scene tab for a single MiniApp.
 * Mounts MiniAppRunner; transfers keep work, closing the final view stops the app.
 */
import { Button, ConfirmDialog, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle, SquareArrowOutUpRight, MessageSquare } from 'lucide-react';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import type { MiniApp, MiniAppDraft } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useAppearance } from '@/infrastructure/appearance';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

import { useSceneManager } from '@/app/hooks/useSceneManager';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { useMiniAppStore } from './miniAppStore';
import { openMiniAppConversation } from './miniAppConversation';
import { useI18n } from '@/infrastructure/i18n';
import { pickLocalizedString } from './utils/pickLocalizedString';
import MiniAppCustomizeEntry from './customization/MiniAppCustomizeEntry';
import MiniAppCustomizePanel from './customization/MiniAppCustomizePanel';
import MiniAppDraftPreview from './customization/MiniAppDraftPreview';
import { useMiniAppCustomizeHotspot } from './customization/useMiniAppCustomizeHotspot';
import MiniAppRunner from './components/MiniAppRunner';
import './MiniAppScene.scss';
import { hasLocalMiniAppPresentation, miniAppPresentationAPI } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { ensureMiniAppTab, useMiniAppPresentationStore } from './miniAppPresentationStore';
import { isRemoteWorkspace } from '@/shared/types';
import { MiniAppSystemAppActions } from './components/MiniAppSystemAppActions';
import { isMiniAppClosing } from './miniAppLifecycle';
import { useSceneStore } from '@/app/stores/sceneStore';
import { renderMiniAppSystemIcon } from './utils/miniAppSystemIcon';

import { SceneChromeContribution } from '@/app/components/SceneTopBar/SceneChrome';
import { MiniAppChromeActions } from './components/MiniAppChromeActions';
import { MiniAppActionTooltip } from './components/MiniAppActionTooltip';

const log = createLogger('MiniAppScene');
const MINIAPP_REFRESH_EVENTS = [
  'miniapp-updated',
  'miniapp-recompiled',
  'miniapp-rolled-back',
  'miniapp-worker-restarted',
] as const;

interface MiniAppSceneProps {
  appId: string;
}

const MiniAppScene: React.FC<MiniAppSceneProps> = ({ appId }) => {
  const markCustomizationActive = useMiniAppStore((state) => state.markCustomizationActive);
  const markCustomizationIdle = useMiniAppStore((state) => state.markCustomizationIdle);
  const composerClaim = useMiniAppStore((state) => state.composerClaims[appId]);
  const { current: appearance } = useAppearance();
  const appearanceMode = appearance?.mode ?? 'dark';
  const { workspace, workspacePath } = useCurrentWorkspace();
  const initialTicket = useMiniAppPresentationStore.getState().tabs[appId];
  const initialPath = useRef(initialTicket ? initialTicket.instance.workspacePath : workspacePath || null).current;
  const presentationSupported = hasLocalMiniAppPresentation() && (Boolean(initialTicket) || !(workspace && isRemoteWorkspace(workspace)));
  const viewId = useMiniAppPresentationStore(state => state.tabs[appId]?.view.viewId);
  const hostEpoch = useMiniAppPresentationStore(state => state.snapshot?.hostEpoch);
  const { closeScene } = useSceneManager();
  const { t, currentLanguage } = useI18n('scenes/miniapp');

  const chromeActionRef = useRef<((actionId: string) => void) | null>(null);
  const [contentReady, setContentReady] = useState(false);
  const [app, setApp] = useState<MiniApp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strictRuntime, setStrictRuntime] = useState(false);
  const [key, setKey] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [windowConfirm, setWindowConfirm] = useState(false);
  const [presentationNotice, setPresentationNotice] = useState<string | null>(null);
  const [presentationBusy, setPresentationBusy] = useState(false);
  const pendingTransfer = useRef<string | null>(null);
  const observedInstance = useMiniAppPresentationStore(state => state.snapshot?.instances.find(instance => instance.appId === appId));
  useEffect(() => {
    if (observedInstance?.pendingView?.kind === 'window') {
      pendingTransfer.current = observedInstance.pendingView.viewId;
    } else if (pendingTransfer.current) {
      pendingTransfer.current = null;
      if (observedInstance?.primaryView?.kind === 'tab') setPresentationNotice(t('presentation.transferFailed'));
    }
  }, [observedInstance, t]);
  const [customizeNotice, setCustomizeNotice] = useState<string | null>(null);
  const [customizePreview, setCustomizePreview] = useState<{
    draft: MiniAppDraft;
    previewKey: number;
  } | null>(null);

  useEffect(() => {
    return () => markCustomizationIdle(appId);
  }, [appId, markCustomizationIdle]);

  useEffect(() => {
    setCustomizePreview(null);
  }, [appId]);

  useEffect(() => {
    if (customizeOpen) {
      markCustomizationActive(appId);
      return;
    }

    markCustomizationIdle(appId);
  }, [appId, customizeOpen, markCustomizationActive, markCustomizationIdle]);

  const load = useCallback(async (id: string) => {
    const scope = getActiveSurfaceScope();
    if (isMiniAppClosing(id, scope) || !useSceneStore.getState().openTabs.some(tab => tab.id === `miniapp:${id}`)) return;
    setLoading(true);
    setContentReady(false);
    setError(null);
    try {
      const ticket = presentationSupported ? await ensureMiniAppTab(id, initialPath) : undefined;
      const loaded = await miniAppAPI.getMiniApp(id, appearanceMode, (ticket?.instance.workspacePath ?? initialPath) || undefined);
      if (!scope.isCurrent() || isMiniAppClosing(id, scope)) return;
      // An app opened directly may finish loading before the catalog. Shutdown
      // still needs its actual permissions and worker policy.
      useMiniAppStore.getState().upsertApp(loaded);
      if (!loaded.compiled_html?.trim()) {
        log.error('MiniApp loaded without compiled_html', { appId: id });
        setError('MiniApp compiled_html is empty');
        setApp(null);
        return;
      }
      setStrictRuntime(loaded.runtime_profile === 'market_strict');
      setApp(loaded);
    } catch (err) {
      log.error('Failed to load app', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [appearanceMode, initialPath, presentationSupported]);

  const markReady = useCallback(() => {
    setContentReady(true);
    const ticket = useMiniAppPresentationStore.getState().tabs[appId];
    if (ticket && hasLocalMiniAppPresentation()) {
      void miniAppPresentationAPI.ready(ticket).catch(error => setPresentationNotice(String(error)));
    }
  }, [appId]);

  const openWindow = async () => {
    setWindowConfirm(false);
    setPresentationBusy(true);
    try {
      await miniAppPresentationAPI.open(appId, 'window', initialPath, app ? renderMiniAppSystemIcon(app.icon) : undefined);
      setPresentationNotice(t('presentation.transferring'));
    } catch (error) { setPresentationNotice(String(error)); }
    finally { setPresentationBusy(false); }
  };

  useEffect(() => {
    if (appId) {
      void load(appId);
    }
  }, [appId, load, hostEpoch, viewId]);

  useEffect(() => {
    const tabId = `miniapp:${appId}` as SceneTabId;
    const shouldHandle = (payload?: { id?: string }) => payload?.id === appId;
    const refresh = () => {
      setKey((value) => value + 1);
      void load(appId);
    };

    const refreshUnlisteners = MINIAPP_REFRESH_EVENTS.map((eventName) =>
      api.listen<{ id?: string }>(eventName, (payload) => {
        if (shouldHandle(payload)) {
          refresh();
        }
      }),
    );
    const unlistenDeleted = api.listen<{ id?: string }>('miniapp-deleted', (payload) => {
      if (shouldHandle(payload)) {
        const store = useMiniAppStore.getState();
        store.setApps(store.apps.filter(candidate => candidate.id !== appId));
        closeScene(tabId);
      }
    });

    return () => {
      refreshUnlisteners.forEach((unlisten) => unlisten());
      unlistenDeleted();
    };
  }, [appId, closeScene, load]);

  const handleOpenCustomize = useCallback(() => {
    setCustomizeNotice(null);
    setCustomizeOpen(true);
  }, []);

  useMiniAppCustomizeHotspot({
    enabled: Boolean(app) && !customizeOpen,
    onOpen: handleOpenCustomize,
  });

  const appName = app ? pickLocalizedString(app, currentLanguage, 'name') : 'Mini App';
  const hasConversation = Boolean(composerClaim || app?.permissions?.agent?.enabled
    && (!strictRuntime || app.permissions.host?.chat_composer));
  const windowPending = presentationBusy || observedInstance?.pendingView?.kind === 'window';
  const windowDisabled = !app || !presentationSupported || windowPending;

  return (
    <div
      className="miniapp-scene"
      data-miniapp-id={appId}
      data-openbitfun-scene="miniapp"
      data-openbitfun-part="root"
      data-openbitfun-state={customizeOpen ? 'customizing' : undefined}
    >
      <SceneChromeContribution sceneId={`miniapp:${appId}`}>
        <div className="miniapp-scene__header-actions" data-openbitfun-scene="miniapp" data-openbitfun-part="header">
          <MiniAppChromeActions actions={app?.chrome?.titlebar?.actions ?? []} locale={currentLanguage}
            disabled={!contentReady || loading} onAction={actionId => chromeActionRef.current?.(actionId)} />
          {hasConversation && <MiniAppActionTooltip content={t('scene.conversation')} disabled={!composerClaim?.sessionId}>
            <IconButton size="xs" disabled={!composerClaim?.sessionId} aria-label={t('scene.conversation')}
              icon={<Icon glyph={MessageSquare} size="sm" />} onClick={() => openMiniAppConversation(appId)} />
          </MiniAppActionTooltip>}
          <MiniAppCustomizeEntry size="xs" disabled={!app || loading} onOpen={handleOpenCustomize} />
          <MiniAppActionTooltip content={presentationSupported ? t('presentation.openWindow') : t('presentation.unsupported')} disabled={windowDisabled}>
            <IconButton size="xs" disabled={windowDisabled}
              loading={windowPending}
              onClick={() => setWindowConfirm(true)} aria-label={t('presentation.openWindow')}
              icon={<Icon glyph={SquareArrowOutUpRight} size="sm" />} />
          </MiniAppActionTooltip>
          {app && <MiniAppSystemAppActions compact key={app.id} app={app} workspacePath={initialPath} supported={presentationSupported} />}
        </div>
      </SceneChromeContribution>
      {presentationNotice && <div role="status">{presentationNotice}</div>}
      <ConfirmDialog open={windowConfirm} onOpenChange={setWindowConfirm} onConfirm={() => void openWindow()}
        title={t('presentation.openWindow')} message={t('presentation.transferWarning')}
        confirmText={t('presentation.openWindow')} cancelText={t('confirmDelete.cancel')} />
      <div className={[
        'miniapp-scene__content',
        customizeOpen && app && 'miniapp-scene__content--customizing',
      ].filter(Boolean).join(' ')} data-openbitfun-scene="miniapp" data-openbitfun-part="content">
        {loading && !app && (
          <div className="miniapp-scene__loading" data-openbitfun-scene="miniapp" data-openbitfun-part="loading">
            <Loader2 size={28} className="miniapp-scene__spinning" strokeWidth={1.5} />
            <span>{t('scene.loading')}</span>
          </div>
        )}
        {error && !app && (
          <div className="miniapp-scene__error" data-openbitfun-scene="miniapp" data-openbitfun-part="error">
            <AlertTriangle size={32} strokeWidth={1.5} />
            <p>{t('scene.loadFailed', { error })}</p>
            <Button variant="outline" size="sm" onClick={() => void load(appId)}>
              {t('scene.retry')}
            </Button>
          </div>
        )}
        {app && (
          <div className="miniapp-scene__runner-shell" data-openbitfun-scene="miniapp" data-openbitfun-part="runner">
            {loading && (
              <div className="miniapp-scene__refresh-overlay" role="status" aria-live="polite">
                <Loader2 size={20} className="miniapp-scene__spinning" strokeWidth={1.5} />
              </div>
            )}
            <MiniAppRunner
              key={`${app.id}-${key}-${viewId ?? 'embedded'}`}
              app={app}
              strictRuntime={strictRuntime}
              workspacePath={presentationSupported ? initialPath : undefined}
              onReady={markReady}
              chromeActionRef={chromeActionRef}
            />
            {customizePreview && (
              <div className="miniapp-scene__preview-stage" role="region" aria-label={t('customize.previewTitle')} data-openbitfun-scene="miniapp" data-openbitfun-part="preview">
                <div className="miniapp-scene__preview-stage-header">
                  <div>
                    <span className="miniapp-scene__preview-stage-title">{t('customize.previewTitle')}</span>
                    <small className="miniapp-scene__preview-stage-hint">{t('customize.previewHint')}</small>
                  </div>
                  <Tooltip content={t('customize.hidePreview')}>
                    <IconButton
                      size="sm"
                      onClick={() => setCustomizePreview(null)}
                      aria-label={t('customize.hidePreview')}
                      icon={<Icon name="xmark" size="lg" />}
                    />
                  </Tooltip>
                </div>
                <div className="miniapp-scene__preview-stage-body">
                  <MiniAppDraftPreview
                    draft={customizePreview.draft}
                    previewKey={customizePreview.previewKey}
                    strictRuntime={strictRuntime}
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {customizeNotice && (
          <div className="miniapp-scene__customize-notice" role="status" data-openbitfun-scene="miniapp" data-openbitfun-part="notice">
            <Icon name="check-circle" size="md" />
            <span>{customizeNotice}</span>
          </div>
        )}
        {app && (
          <MiniAppCustomizePanel
            open={customizeOpen}
            app={app}
            appName={appName}
            appearanceMode={appearanceMode}
            workspaceId={workspace?.id}
            workspacePath={workspacePath || undefined}
            remoteConnectionId={workspace?.connectionId}
            remoteSshHost={workspace?.sshHost}
            previewOpen={Boolean(customizePreview)}
            onPreviewChange={setCustomizePreview}
            onClose={() => setCustomizeOpen(false)}
            onApplied={(updatedApp) => {
              setApp(updatedApp);
              setKey((value) => value + 1);
              setCustomizeNotice(t('customize.applySaved'));
            }}
          />
        )}
      </div>
    </div>
  );
};

export default MiniAppScene;
