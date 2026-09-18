import { OverflowText, Button, Icon, IconButton, Textarea, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, EyeOff, Loader2, Send } from 'lucide-react';

import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { MiniApp, MiniAppCustomizationMetadata, MiniAppDraft } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { buildMiniAppCustomizationPrompt } from './miniAppCustomizationPrompt';
import { shouldSubmitMiniAppCustomizationRequest } from './miniAppCustomizationInput';
import { getMiniAppBuiltinUpdateNotice } from './miniAppCustomizationMetadata';
import { requiresPermissionConfirmation } from './miniAppCustomizationRisk';
import { getNextMiniAppPreviewOpenState } from './miniAppCustomizationPreview';
import {
  cleanupMiniAppCustomizationSession,
  isMiniAppCustomizationSessionRunning,
  launchMiniAppCustomizationSession,
} from './miniAppCustomizationSession';
import type { MiniAppCustomizationState } from './miniAppCustomizationTypes';
import MiniAppPermissionDiffDialog from './MiniAppPermissionDiffDialog';

const log = createLogger('MiniAppCustomizePanel');

const BtwSessionPanel = React.lazy(() =>
  import('@/flow_chat/components/btw/BtwSessionPanel').then((module) => ({
    default: module.BtwSessionPanel,
  }))
);

const initialState: MiniAppCustomizationState = {
  stage: 'notice',
  draft: null,
  permissionDiff: null,
  customizationSessionId: null,
  error: null,
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface MiniAppCustomizePanelProps {
  open: boolean;
  app: MiniApp;
  appName: string;
  appearanceMode?: string;
  /** Owning workspace ID; authoritative for the customization session. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  previewOpen: boolean;
  onPreviewChange: (preview: { draft: MiniAppDraft; previewKey: number } | null) => void;
  onClose: () => void;
  onApplied: (app: MiniApp) => void;
}

export const MiniAppCustomizePanel: React.FC<MiniAppCustomizePanelProps> = ({
  open,
  app,
  appName,
  appearanceMode,
  workspaceId,
  workspacePath,
  remoteConnectionId,
  remoteSshHost,
  previewOpen,
  onPreviewChange,
  onClose,
  onApplied,
}) => {
  const { t } = useI18n('scenes/miniapp');
  const [state, setState] = useState<MiniAppCustomizationState>(initialState);
  const [userRequest, setUserRequest] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissingBuiltinUpdate, setDismissingBuiltinUpdate] = useState(false);
  const [customizationMetadata, setCustomizationMetadata] = useState<MiniAppCustomizationMetadata | null>(null);
  const resolvedAppearanceMode = appearanceMode ?? 'dark';
  const subscribeToFlowChat = useCallback(
    (onStoreChange: () => void) => flowChatStore.subscribe(() => onStoreChange()),
    [],
  );
  const getEditorRunningSnapshot = useCallback(
    () => isMiniAppCustomizationSessionRunning(
      state.customizationSessionId
        ? flowChatStore.getState().sessions.get(state.customizationSessionId)
        : null,
    ),
    [state.customizationSessionId],
  );
  const editorRunning = useSyncExternalStore(
    subscribeToFlowChat,
    getEditorRunningSnapshot,
    () => false,
  );

  const trimmedRequest = userRequest.trim();
  const busy = state.stage === 'drafting'
    || state.stage === 'applying'
    || editorRunning
    || discarding
    || refreshing;
  const hasPreview = state.draft !== null;
  const builtinUpdateNotice = useMemo(
    () => getMiniAppBuiltinUpdateNotice(customizationMetadata),
    [customizationMetadata],
  );

  useEffect(() => {
    setState(initialState);
    setUserRequest('');
    setPreviewKey(0);
    setDismissingBuiltinUpdate(false);
    setCustomizationMetadata(null);
    onPreviewChange(null);
  }, [app.id, onPreviewChange]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    void miniAppAPI.getCustomizationMetadata(app.id)
      .then((metadata) => {
        if (!cancelled) {
          setCustomizationMetadata(metadata);
        }
      })
      .catch((error) => {
        log.warn('MiniApp customization metadata load failed', { appId: app.id, error });
      });

    return () => {
      cancelled = true;
    };
  }, [app.id, open]);

  useEffect(() => {
    if (open && state.stage === 'idle' && !state.draft) {
      setState(initialState);
    }
  }, [open, state.draft, state.stage]);

  const ensureWorkspace = useCallback((): string => {
    if (!workspacePath) {
      throw new Error(t('customize.workspaceRequired'));
    }
    return workspacePath;
  }, [t, workspacePath]);

  const launchEditor = useCallback(async (draft: MiniAppDraft, request: string) => {
    const workspace = ensureWorkspace();
    const prompt = buildMiniAppCustomizationPrompt({
      appId: app.id,
      appName,
      draftId: draft.draftId,
      draftRoot: draft.draftRoot,
      userRequest: request,
    });

    const created = await launchMiniAppCustomizationSession({
      appId: app.id,
      appName,
      workspaceId,
      workspacePath: workspace,
      remoteConnectionId,
      remoteSshHost,
      sessionName: t('customize.sessionName', { name: appName }),
      prompt,
      displayMessage: request,
    });

    setState((prev) => ({
      ...prev,
      stage: 'preview',
      customizationSessionId: created.sessionId,
      error: null,
    }));
  }, [app.id, appName, ensureWorkspace, remoteConnectionId, remoteSshHost, t, workspaceId]);

  const handleStart = useCallback(async () => {
    if (!trimmedRequest || busy) {
      return;
    }

    setState((prev) => ({ ...prev, stage: 'drafting', error: null }));
    try {
      const draft = state.draft ?? await miniAppAPI.createDraft(app.id, resolvedAppearanceMode, workspacePath);
      setState((prev) => ({
        ...prev,
        stage: 'drafting',
        draft,
        permissionDiff: null,
        error: null,
      }));
      const previousSessionId = state.customizationSessionId;
      await launchEditor(draft, trimmedRequest);
      cleanupMiniAppCustomizationSession(previousSessionId);
    } catch (error) {
      log.error('MiniApp customization launch failed', error);
      setState((prev) => ({
        ...prev,
        stage: prev.draft ? 'preview' : 'notice',
        error: t('customize.launchFailed', { error: formatError(error) }),
      }));
    }
  }, [app.id, busy, launchEditor, resolvedAppearanceMode, state.customizationSessionId, state.draft, t, trimmedRequest, workspacePath]);

  const handleRefreshPreview = useCallback(async () => {
    if (!state.draft || refreshing) {
      return;
    }

    setRefreshing(true);
    try {
      const draft = await miniAppAPI.syncDraftFromFs(
        app.id,
        state.draft.draftId,
        resolvedAppearanceMode,
        workspacePath,
      );
      setState((prev) => ({ ...prev, draft, stage: 'preview', error: null }));
      setPreviewKey((value) => {
        const nextKey = value + 1;
        if (previewOpen) {
          onPreviewChange({ draft, previewKey: nextKey });
        }
        return nextKey;
      });
    } catch (error) {
      log.error('MiniApp draft preview refresh failed', error);
      setState((prev) => ({
        ...prev,
        error: t('customize.refreshFailed', { error: formatError(error) }),
      }));
    } finally {
      setRefreshing(false);
    }
  }, [app.id, onPreviewChange, previewOpen, refreshing, resolvedAppearanceMode, state.draft, t, workspacePath]);

  const applyDraft = useCallback(async () => {
    if (!state.draft) {
      return;
    }

    setState((prev) => ({ ...prev, stage: 'applying', error: null }));
    try {
      const updated = await miniAppAPI.applyDraft(
        app.id,
        state.draft.draftId,
        resolvedAppearanceMode,
        workspacePath,
      );
      cleanupMiniAppCustomizationSession(state.customizationSessionId);
      setState(initialState);
      onPreviewChange(null);
      onApplied(updated);
      onClose();
    } catch (error) {
      log.error('MiniApp draft apply failed', error);
      setState((prev) => ({
        ...prev,
        stage: 'preview',
        error: t('customize.applyFailed', { error: formatError(error) }),
      }));
    }
  }, [app.id, onApplied, onClose, onPreviewChange, resolvedAppearanceMode, state.customizationSessionId, state.draft, t, workspacePath]);

  const handleApply = useCallback(async () => {
    if (!state.draft || busy) {
      return;
    }

    setState((prev) => ({ ...prev, error: null }));
    try {
      const permissionDiff = await miniAppAPI.permissionDiffForDraft(app.id, state.draft.draftId);
      if (requiresPermissionConfirmation(permissionDiff)) {
        setState((prev) => ({ ...prev, stage: 'permission-review', permissionDiff }));
        return;
      }
      await applyDraft();
    } catch (error) {
      log.error('MiniApp permission diff failed', error);
      setState((prev) => ({
        ...prev,
        stage: 'preview',
        error: t('customize.permissionCheckFailed', { error: formatError(error) }),
      }));
    }
  }, [app.id, applyDraft, busy, state.draft, t]);

  const handleDiscard = useCallback(async () => {
    if (discarding) {
      return;
    }

    const draft = state.draft;
    const customizationSessionId = state.customizationSessionId;
    setDiscarding(true);
    try {
      if (draft) {
        await miniAppAPI.discardDraft(app.id, draft.draftId);
      }
      cleanupMiniAppCustomizationSession(customizationSessionId);
      setState({ ...initialState, stage: 'idle' });
      setUserRequest('');
      setPreviewKey(0);
      onPreviewChange(null);
      onClose();
    } catch (error) {
      log.error('MiniApp draft discard failed', error);
      setState((prev) => ({
        ...prev,
        error: t('customize.discardFailed', { error: formatError(error) }),
      }));
    } finally {
      setDiscarding(false);
    }
  }, [app.id, discarding, onClose, onPreviewChange, state.customizationSessionId, state.draft, t]);

  const handleDismissBuiltinUpdate = useCallback(async () => {
    if (!builtinUpdateNotice?.sourceHash || dismissingBuiltinUpdate) {
      return;
    }

    setDismissingBuiltinUpdate(true);
    try {
      const metadata = await miniAppAPI.declineBuiltinUpdate(
        app.id,
        builtinUpdateNotice.builtinVersion,
        builtinUpdateNotice.sourceHash,
      );
      setCustomizationMetadata(metadata);
    } catch (error) {
      log.error('MiniApp builtin update dismissal failed', error);
      setState((prev) => ({
        ...prev,
        error: t('customize.dismissBuiltinUpdateFailed', { error: formatError(error) }),
      }));
    } finally {
      setDismissingBuiltinUpdate(false);
    }
  }, [app.id, builtinUpdateNotice, dismissingBuiltinUpdate, t]);

  const handleClose = useCallback(() => {
    if (busy) {
      return;
    }

    const draft = state.draft;
    const customizationSessionId = state.customizationSessionId;
    setState({ ...initialState, stage: 'idle' });
    setUserRequest('');
    setPreviewKey(0);
    onPreviewChange(null);
    onClose();
    cleanupMiniAppCustomizationSession(customizationSessionId);

    if (draft) {
      void miniAppAPI.discardDraft(app.id, draft.draftId).catch((error) => {
        log.warn('MiniApp draft background discard failed after close', {
          appId: app.id,
          draftId: draft.draftId,
          error,
        });
      });
    }
  }, [app.id, busy, onClose, onPreviewChange, state.customizationSessionId, state.draft]);

  const handleTogglePreview = useCallback(() => {
    const nextOpen = getNextMiniAppPreviewOpenState({
      hasPreview,
      isOpen: previewOpen,
    });

    if (nextOpen && state.draft) {
      onPreviewChange({ draft: state.draft, previewKey });
      return;
    }

    onPreviewChange(null);
  }, [hasPreview, onPreviewChange, previewKey, previewOpen, state.draft]);

  const editorStatus = useMemo(() => {
    if (!state.customizationSessionId) {
      return null;
    }
    return t('customize.editorOpened');
  }, [state.customizationSessionId, t]);

  if (!open) {
    return null;
  }

  return (
    <aside
      className="miniapp-customize-panel"
      data-openbitfun-component="miniapp-customize-panel"
      data-openbitfun-part="root"
      data-openbitfun-stage={state.stage}
      data-openbitfun-state={[busy && 'busy', state.error && 'error', previewOpen && 'preview-open'].filter(Boolean).join(' ')}
      aria-label={t('customize.title')}
    >
      <div className="miniapp-customize-panel__header" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="header">
        <div>
          <h3>{t('customize.title')}</h3>
          <OverflowText>{appName}</OverflowText>
        </div>
        <Tooltip content={t('customize.close')} disabled={busy}>
          <IconButton
            size="sm"
            onClick={handleClose}
            disabled={busy}
            aria-label={t('customize.close')}
            icon={<Icon name="xmark" size="lg" />}
          />
        </Tooltip>
      </div>

      <div className="miniapp-customize-panel__notice" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="notice">
        <AlertTriangle size={18} />
        <div>
          <strong>{t('customize.riskTitle')}</strong>
          <p>{t('customize.riskBody')}</p>
        </div>
      </div>

      {builtinUpdateNotice && (
        <div className="miniapp-customize-panel__notice miniapp-customize-panel__notice--update" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="notice">
          <AlertTriangle size={18} />
          <div>
            <strong>{t('customize.builtinUpdateTitle', { version: builtinUpdateNotice.builtinVersion })}</strong>
            <p>{t('customize.builtinUpdateBody')}</p>
            {builtinUpdateNotice.sourceHash && (
              <div className="miniapp-customize-panel__notice-actions" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="noticeActions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDismissBuiltinUpdate()}
                  disabled={dismissingBuiltinUpdate}
                  loading={dismissingBuiltinUpdate}
                  leadingIcon={<Icon name="xmark" size="sm" />}
                >

                  {t('customize.dismissBuiltinUpdate')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <label className="miniapp-customize-panel__request" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="request">
        <span>{t('customize.requestLabel')}</span>
        <Textarea
          value={userRequest}
          onValueChange={setUserRequest}
          onKeyDown={(event) => {
            if (!shouldSubmitMiniAppCustomizationRequest(event)) {
              return;
            }
            event.preventDefault();
            void handleStart();
          }}
          placeholder={t('customize.requestPlaceholder')}
          disabled={busy}
          rows={4}
        />
      </label>

      <div className="miniapp-customize-panel__actions" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleStart()}
          disabled={!trimmedRequest || busy}
          loading={state.stage === 'drafting'}
          leadingIcon={<Send size={14} />}
        >

          {state.draft ? t('customize.retryEditor') : t('customize.start')}
        </Button>
        {state.draft && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRefreshPreview()}
            disabled={busy}
            loading={refreshing}
            leadingIcon={<Icon name="refresh" size="sm" />}
          >

            {t('customize.refreshPreview')}
          </Button>
        )}
        {state.draft && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleTogglePreview}
            disabled={busy}
          >
            {previewOpen ? <EyeOff size={14} /> : <Icon name="eye" size="sm" />}
            {previewOpen ? t('customize.hidePreview') : t('customize.openPreview')}
          </Button>
        )}
      </div>

      {state.error && (
        <div className="miniapp-customize-panel__error" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="error" role="alert">
          {state.error}
        </div>
      )}

      {editorStatus && (
        <div className="miniapp-customize-panel__status" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="status">
          <Icon name="check-line" size="sm" />
          <span>{editorStatus}</span>
        </div>
      )}

      {state.customizationSessionId && (
        <div className="miniapp-customize-panel__chat" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="chat">
          <React.Suspense
            fallback={(
              <div className="miniapp-customize-panel__chat-loading" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="chatLoading">
                <Loader2 size={16} className="miniapp-scene__spinning" />
                <span>{t('customize.chatLoading')}</span>
              </div>
            )}
          >
            <BtwSessionPanel
              childSessionId={state.customizationSessionId}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          </React.Suspense>
        </div>
      )}

      <div className="miniapp-customize-panel__footer" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="footer">
        <Button
          variant="fill"
          size="sm"
          onClick={() => void handleDiscard()}
          disabled={busy}
          loading={discarding}
          leadingIcon={<Icon name="delete" size="sm" />}
        >

          {t('customize.discard')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleApply()}
          disabled={!hasPreview || busy}
          loading={state.stage === 'applying'}
        >
          {t('customize.apply')}
        </Button>
      </div>

      {state.stage === 'applying' && (
        <div className="miniapp-customize-panel__busy" data-openbitfun-component="miniapp-customize-panel" data-openbitfun-part="busy">
          <Loader2 size={16} className="miniapp-scene__spinning" />
          <span>{t('customize.applying')}</span>
        </div>
      )}

      <MiniAppPermissionDiffDialog
        isOpen={state.stage === 'permission-review'}
        diff={state.permissionDiff}
        applying={state.stage === 'applying'}
        onCancel={() => setState((prev) => ({ ...prev, stage: 'preview' }))}
        onConfirm={() => void applyDraft()}
      />
    </aside>
  );
};

export default MiniAppCustomizePanel;
