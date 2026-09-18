/**
 * MiniAppScene — standalone scene tab for a single MiniApp.
 * Mounts MiniAppRunner; closing its scene stops the app through the shared lifecycle.
 */
import { OverflowText, Button, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
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
  const { closeScene } = useSceneManager();
  const { t, currentLanguage } = useI18n('scenes/miniapp');

  const [app, setApp] = useState<MiniApp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strictRuntime, setStrictRuntime] = useState(false);
  const [key, setKey] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
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
    setLoading(true);
    setError(null);
    try {
      const loaded = await miniAppAPI.getMiniApp(id, appearanceMode, workspacePath || undefined);
      if (!scope.isCurrent()) return;
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
  }, [appearanceMode, workspacePath]);

  useEffect(() => {
    if (appId) {
      void load(appId);
    }
  }, [appId, load]);

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

  const handleReload = () => {
    if (appId) {
      setKey((value) => value + 1);
      void load(appId);
    }
  };

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

  return (
    <div
      className="miniapp-scene"
      data-miniapp-id={appId}
      data-openbitfun-scene="miniapp"
      data-openbitfun-part="root"
      data-openbitfun-state={customizeOpen ? 'customizing' : undefined}
    >
      <div className="miniapp-scene__header" data-openbitfun-scene="miniapp" data-openbitfun-part="header">
        <div className="miniapp-scene__header-center">
          {app ? (
            <OverflowText className="miniapp-scene__title">{appName}</OverflowText>
          ) : (
            <OverflowText className="miniapp-scene__title miniapp-scene__title--loading">Mini App</OverflowText>
          )}
        </div>
        <div className="miniapp-scene__header-actions">
          {hasConversation && <Button variant="text" size="sm" disabled={!composerClaim?.sessionId}
            onClick={() => openMiniAppConversation(appId)}>
            {t('scene.conversation')}
          </Button>}
          <MiniAppCustomizeEntry
            disabled={!app || loading}
            onOpen={handleOpenCustomize}
          />
          <Tooltip content={t('scene.reload')} disabled={loading}>
            <IconButton
              size="sm"
              onClick={handleReload}
              disabled={loading}
              loading={loading}
              aria-label={t('scene.reload')}
              icon={<Icon name="refresh" size="lg" />}
            />
          </Tooltip>
        </div>
      </div>
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
              key={`${app.id}-${key}`}
              app={app}
              strictRuntime={strictRuntime}
            />
            {customizePreview && (
              <div className="miniapp-scene__preview-stage" role="region" aria-label={t('customize.previewTitle')} data-openbitfun-scene="miniapp" data-openbitfun-part="preview">
                <div className="miniapp-scene__preview-stage-header">
                  <div>
                    <span>{t('customize.previewTitle')}</span>
                    <small>{t('customize.previewHint')}</small>
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
