/**
 * User message item component.
 * Renders user input messages.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { RotateCcw, Loader2 } from 'lucide-react';
import type { DialogTurn, FlowUserSteeringItem } from '../../types/flow-chat';
import { flowChatManager } from '../../services/FlowChatManager';
import { useFlowChatContext } from './FlowChatContext';
import { useActiveSession } from '../../store/modernFlowChatStore';
import { flowChatStore } from '../../store/FlowChatStore';
import {
  FLOWCHAT_TURNS_ROLLED_BACK_EVENT,
  type FlowChatTurnsRolledBackRequest,
} from '../../events/flowchatNavigation';
import { useMessageEditStore } from '../../store/messageEditStore';
import { useSessionMutationStore } from '../../store/sessionMutationStore';
import { useSessionStateMachine } from '../../hooks/useSessionStateMachine';
import { SessionExecutionState, stateMachineManager } from '../../state-machine';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { globalEventBus } from '@/infrastructure/event-bus';
import { shouldIgnoreCardToggleClick } from '@/shared/utils/textSelection';
import { observeElementResize } from '@/shared/utils/sharedResizeObserver';
import { formatContextForPrompt } from '@/shared/utils/contextPrompt';
import { Tooltip, Icon } from '@openbitfun/ui';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { ToolProcessingDots } from '@openbitfun/ui/flow-chat';
import { UserMessageEditComposer } from './UserMessageEditComposer';
import {
  describeUserMessageEditImpact,
  editAndRerunUserMessage,
} from '../../services/UserMessageEditService';
import { rollbackSessionToTurn } from '../../services/SessionRollbackService';
import { createLogger } from '@/shared/utils/logger';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import { SessionUsageReportCard } from '../usage/SessionUsageReportCard';
import type { SessionUsagePanelTab } from '../usage/sessionUsagePanelTypes';
import { coerceSessionUsageReport } from '../usage/usageReportUtils';
import { resolveSessionRelationship } from '../../utils/sessionMetadata';
import { isRemoteWorkspaceSession } from '../../utils/sessionWorkspace';
import { resolveSessionDriverId } from '../../session-drivers/resolve';
import { absoluteSessionTurnIndexForId } from '../../utils/flowChatTurnOrdinal';
import {
  composerPresentationToAccessibleText,
  composerPresentationContexts,
  composerPresentationSessionReferences,
  composerPresentationToEditorText,
  composerPresentationToModelText,
  hasComposerPresentationReferences,
  parseComposerPresentation,
  type ComposerPresentation,
} from '../../utils/composerPresentation';
import { restoreImageContextsFromPayload } from '../../utils/imageContextRestoration';
import { UserMessagePresentationContent, UserMessageTextContent } from './UserMessagePresentationContent';
import { UserMessageImage } from './UserMessageImage';
import './UserMessageItem.scss';

const log = createLogger('UserMessageItem');

interface UserMessageItemProps {
  message: DialogTurn['userMessage'];
  turnId: string;
  absoluteTurnIndex?: number;
  turnStatus?: DialogTurn['status'];
  steeringStatus?: FlowUserSteeringItem['status'];
}

function buildPresentationRerunPayload(presentation: ComposerPresentation): {
  message: string;
  displayMessage: string;
  userMessageMetadata: Record<string, unknown>;
} {
  const modelText = composerPresentationToModelText(presentation);
  const contextSection = composerPresentationContexts(presentation)
    .filter(context => context.type !== 'session-reference')
    .map(formatContextForPrompt)
    .filter(Boolean)
    .join('\n');
  const sessionReferences = composerPresentationSessionReferences(presentation).map(context => ({
    sessionId: context.sessionId,
    workspacePath: context.workspacePath,
    remoteConnectionId: context.remoteConnectionId,
    remoteSshHost: context.remoteSshHost,
  }));

  return {
    message: contextSection ? `${contextSection}\n\n${modelText}` : modelText,
    displayMessage: composerPresentationToEditorText(presentation),
    userMessageMetadata: {
      composerPresentation: presentation,
      ...(sessionReferences.length > 0 ? { sessionReferences } : {}),
    },
  };
}

export const UserMessageItem = React.memo<UserMessageItemProps>(
  ({ message, turnId, absoluteTurnIndex, turnStatus, steeringStatus }) => {
    const { t, formatDate } = useI18n('flow-chat');
    const {
      sessionId,
      activeSessionOverride,
      allowUserMessageRollback = true,
      allowUserMessageEdit = true,
    } = useFlowChatContext();
    const activeSessionFromStore = useActiveSession();
    const activeSession = activeSessionOverride ?? activeSessionFromStore;
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [lightboxImage, setLightboxImage] = useState<string | null>(null);
    // Fine-grained selectors: only the message being edited re-renders on
    // draft keystrokes; other list items subscribe to booleans that rarely flip.
    const isEditing = useMessageEditStore(s => s.editingTurnId === turnId);
    const editDraft = useMessageEditStore(s => (s.editingTurnId === turnId ? s.draft : ''));
    const isEditSubmitting = useMessageEditStore(s => s.isSubmitting);
    const beginEdit = useMessageEditStore(s => s.beginEdit);
    const cancelEdit = useMessageEditStore(s => s.cancelEdit);
    const setEditDraft = useMessageEditStore(s => s.setDraft);
    const setEditSubmitting = useMessageEditStore(s => s.setSubmitting);
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const messageContent = typeof message?.content === 'string' ? message.content : String(message?.content || '');
    const sentTimestamp = typeof message?.timestamp === 'number'
      && Number.isFinite(message.timestamp)
      && message.timestamp > 0
      ? message.timestamp
      : null;
    const sentTime = useMemo(() => sentTimestamp === null ? null : formatDate(sentTimestamp, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }), [formatDate, sentTimestamp]);
    const sentAtLabel = useMemo(() => sentTimestamp === null ? null : t('message.sentAt', {
      time: formatDate(sentTimestamp, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      }),
    }), [formatDate, sentTimestamp, t]);
    const composerPresentation = useMemo(() => {
      const presentation = parseComposerPresentation(message?.metadata?.composerPresentation);
      return hasComposerPresentationReferences(presentation) ? presentation : null;
    }, [message?.metadata?.composerPresentation]);
    const messageImages = useMemo(() => message?.images ?? [], [message?.images]);
    const restoredComposerContexts = useMemo(() => [
      ...(composerPresentation ? composerPresentationContexts(composerPresentation) : []),
      ...restoreImageContextsFromPayload({
        id: message?.id ?? turnId,
        timestamp: message?.timestamp ?? 0,
        imageDisplayData: messageImages,
      }),
    ], [composerPresentation, message?.id, message?.timestamp, messageImages, turnId]);
    const isUsageReportMessage = message?.metadata?.localCommandKind === 'usage_report';
    const isGoalLoadingMessage = Boolean(message?.metadata?.threadGoalKickoff);
    const isThreadGoalContinuationCheck = Boolean(message?.metadata?.threadGoalContinuation);
    const isThreadGoalSystemMessage = Boolean(
      message?.metadata?.threadGoalKickoff
      || message?.metadata?.threadGoalObjectiveUpdated
      || message?.metadata?.threadGoalContinuation
    );
    const isUsageReportLoading = message?.metadata?.usageReportStatus === 'loading';
    const usageReport = coerceSessionUsageReport(message?.metadata?.usageReport);
    const sessionRelationship = useMemo(
      () => resolveSessionRelationship(activeSession),
      [activeSession]
    );
    const canShowRollbackAction = allowUserMessageRollback && !sessionRelationship.isSubagent;

    const currentSession = activeSessionOverride
      ?? (sessionId ? flowChatStore.getState().sessions.get(sessionId) ?? null : null)
      ?? activeSessionFromStore;
    const turnIndex = currentSession?.dialogTurns.findIndex(t => t.id === turnId) ?? -1;
    const dialogTurn = turnIndex >= 0 ? currentSession?.dialogTurns[turnIndex] : null;
    const resolvedTurnStatus = dialogTurn?.status ?? turnStatus;
    const isFailed = resolvedTurnStatus === 'error';
    const resolvedSessionId = sessionId ?? currentSession?.sessionId;
    const sessionMachine = useSessionStateMachine(resolvedSessionId ?? null);
    const sessionExecutionState = sessionMachine && sessionMachine.sessionId === resolvedSessionId
      ? sessionMachine.currentState
      : resolvedSessionId
        ? stateMachineManager.getCurrentState(resolvedSessionId)
        : SessionExecutionState.IDLE;
    const isSessionIdle = sessionExecutionState === SessionExecutionState.IDLE;
    const sessionMutation = useSessionMutationStore(s => (
      resolvedSessionId ? s.mutations.get(resolvedSessionId) : undefined
    ));
    const resolvedAbsoluteTurnIndex = absoluteTurnIndex ?? (
      currentSession ? absoluteSessionTurnIndexForId(currentSession, turnId) : undefined
    );
    const actionTurnIndex = resolvedAbsoluteTurnIndex !== undefined
      ? resolvedAbsoluteTurnIndex - 1
      : -1;
    const isDispatchSession = resolveSessionDriverId(resolvedSessionId ?? '', currentSession ?? undefined) === 'dispatch';
    const isRemoteSession = isRemoteWorkspaceSession(currentSession ?? undefined, null) || isDispatchSession;
    const isSystemTriggered = Boolean(
      message?.metadata?.triggerSource && message.metadata.triggerSource !== 'desktop_ui',
    );
    const canRollback =
      !steeringStatus &&
      canShowRollbackAction &&
      !!resolvedSessionId &&
      actionTurnIndex >= 0 &&
      !isRemoteSession &&
      isSessionIdle &&
      !sessionMutation &&
      !isEditSubmitting;
    const canEditBase =
      allowUserMessageEdit &&
      !!resolvedSessionId &&
      actionTurnIndex >= 0 &&
      !isRemoteSession &&
      !isThreadGoalSystemMessage &&
      !isSystemTriggered &&
      !steeringStatus;
    const canEdit = canEditBase && isSessionIdle && !isEditSubmitting && !sessionMutation;
    const canShowEditAction = allowUserMessageEdit && !isFailed && !isThreadGoalSystemMessage;
    const editDisabledReason = isDispatchSession
      ? t('message.editDisabledDispatch')
      : isRemoteSession
      ? t('message.editDisabledRemote')
      : isSystemTriggered
        ? t('message.cannotEdit')
        : steeringStatus
          ? t('message.cannotEdit')
          : !resolvedSessionId || actionTurnIndex < 0
              ? t('message.editDisabledHistoryNotReady')
              : !isSessionIdle
                ? t('message.editDisabledBusy')
              : t('message.cannotEdit');
    const rollbackTooltip = canRollback
      ? t('message.rollbackTo', { index: actionTurnIndex + 1 })
      : isDispatchSession
        ? t('message.rollbackDisabledDispatch')
      : isRemoteSession
        ? t('message.rollbackDisabledRemote')
        : !isSessionIdle
          ? t('message.rollbackDisabledBusy')
        : t('message.cannotRollback');
    const steeringTag = steeringStatus === 'pending'
      ? {
          className: 'user-message-item__steering-tag--pending',
          label: t('steering.statusPending'),
        }
      : null;

    const displayText = useMemo(() => {
      let cleaned = messageContent;
      if (isThreadGoalContinuationCheck) {
        cleaned = cleaned.replace(/\s*\n+\s*/g, ' ').trim();
      }

      // Strip [Image: ...] context lines when images are shown as thumbnails.
      if (messageImages.length > 0) {
        cleaned = cleaned
          .replace(/\[Image:.*?\]\n(?:Path:.*?\n|Image ID:.*?\n)?/g, '')
          .trim();
      }

      return cleaned;
    }, [isThreadGoalContinuationCheck, messageContent, messageImages]);
    const copyText = composerPresentation
      ? composerPresentationToAccessibleText(composerPresentation)
      : messageContent;
    
    // Check whether content overflows. Uses the shared ResizeObserver instead
    // of a per-message window resize listener: observer callbacks run after
    // layout, so the scrollHeight/clientHeight reads do not force reflow.
    useEffect(() => {
      const element = contentRef.current;
      if (!element || expanded) {
        setHasOverflow(false);
        return;
      }

      const checkOverflow = () => {
        // Detect truncated text.
        const isOverflowing = element.scrollHeight > element.clientHeight ||
                              element.scrollWidth > element.clientWidth;
        setHasOverflow(isOverflowing);
      };

      checkOverflow();

      return observeElementResize(element, checkOverflow);
      // `isEditing` / `isFailed` swap which DOM node `contentRef` points at, and
      // the observed element is captured by this effect (unlike the previous
      // window-resize handler, which re-read the ref lazily on every event), so
      // the effect must re-run on those transitions or it keeps observing a
      // detached node and never observes the live one.
    }, [composerPresentation, displayText, expanded, isEditing, isFailed]);
    
    // Copy the user message.
    const handleCopy = useCallback(async (e: React.MouseEvent) => {
      e.stopPropagation(); // Prevent toggle via bubbling.
      try {
        await navigator.clipboard.writeText(copyText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        log.error('Failed to copy', error);
      }
    }, [copyText]);

    const handleRollback = useCallback(async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canRollback || !resolvedSessionId) return;

      const index = actionTurnIndex + 1;
      const confirmed = await confirmDanger(
        t('message.rollbackDialogTitle', { index }),
        (
          <>
            <p className="confirm-dialog__message-intro">{t('message.rollbackDialogIntro')}</p>
            <ul className="confirm-dialog__bullet-list">
              <li>{t('message.rollbackDialogBulletFiles')}</li>
              <li>{t('message.rollbackDialogBulletHistory')}</li>
            </ul>
          </>
        )
      );
      if (!confirmed) return;

      try {
        const result = await rollbackSessionToTurn({
          sessionId: resolvedSessionId,
          targetTurnId: turnId,
          kind: 'rollback',
        });

        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent<FlowChatTurnsRolledBackRequest>(
            FLOWCHAT_TURNS_ROLLED_BACK_EVENT,
            { detail: { sessionId: resolvedSessionId, fromTurnIndex: result.fromTurnIndex } },
          ));
        });

        const composerContent = result.composerText ?? messageContent;
        if (composerContent.trim().length > 0 || restoredComposerContexts.length > 0) {
          globalEventBus.emit('fill-chat-input', {
            content: composerContent,
            contexts: restoredComposerContexts,
            ...(composerPresentation ? { composerPresentation } : {}),
          });
        }

        notificationService.success(t('message.rollbackSuccess'));
      } catch (error) {
        log.error('Rollback failed', error);
        notificationService.error(`${t('message.rollbackFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, [actionTurnIndex, canRollback, composerPresentation, resolvedSessionId, restoredComposerContexts, t, turnId, messageContent]);

    const handleBeginEdit = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canEdit) return;
      beginEdit(turnId, messageContent);
    }, [beginEdit, canEdit, messageContent, turnId]);

    const handleSubmitEdit = useCallback(async (submittedPresentation?: ComposerPresentation) => {
      if (!resolvedSessionId || actionTurnIndex < 0 || isEditSubmitting) return;

      const editedPresentation = submittedPresentation ?? composerPresentation;
      const editedContent = editedPresentation
        ? composerPresentationToEditorText(editedPresentation)
        : editDraft.trim();
      if (!editedContent || editedContent === messageContent.trim()) {
        cancelEdit();
        return;
      }

      const impact = describeUserMessageEditImpact(resolvedSessionId);
      const confirmed = await confirmDanger(
        t('message.editDialogTitle', { index: actionTurnIndex + 1 }),
        (
          <>
            <p className="confirm-dialog__message-intro">{t('message.editDialogIntro')}</p>
            <ul className="confirm-dialog__bullet-list">
              {impact.willStopRunningTask && <li>{t('message.editDialogBulletStopRunning')}</li>}
              {impact.willRestoreFiles && <li>{t('message.editDialogBulletFiles')}</li>}
              {impact.willDeleteTurns && <li>{t('message.editDialogBulletHistory')}</li>}
              {impact.willRerun && <li>{t('message.editDialogBulletRerun')}</li>}
            </ul>
          </>
        )
      );
      if (!confirmed) return;

      setEditSubmitting(true);
      try {
        await editAndRerunUserMessage({
          sessionId: resolvedSessionId,
          turnId,
          originalContent: messageContent,
          editedContent,
          agentType: currentSession?.mode,
          rerun: (content, agentType, sessionMutationLeaseId) => {
            if (!editedPresentation) {
              return flowChatManager.sendMessage(
                content,
                resolvedSessionId,
                undefined,
                agentType,
                undefined,
                { sessionMutationLeaseId },
              );
            }

            const payload = buildPresentationRerunPayload(editedPresentation);
            return flowChatManager.sendMessage(
              payload.message,
              resolvedSessionId,
              payload.displayMessage,
              agentType,
              undefined,
              {
                userMessageMetadata: payload.userMessageMetadata,
                sessionMutationLeaseId,
              },
            );
          },
        });
        cancelEdit();
        notificationService.success(t('message.editSuccess'));
      } catch (error) {
        log.error('Message edit failed', { sessionId: resolvedSessionId, turnId, error });
        notificationService.error(`${t('message.editFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setEditSubmitting(false);
      }
    }, [
      cancelEdit,
      actionTurnIndex,
      composerPresentation,
      currentSession?.mode,
      editDraft,
      isEditSubmitting,
      messageContent,
      resolvedSessionId,
      setEditSubmitting,
      t,
      turnId,
    ]);
    
    // Toggle expanded state.
    const handleToggleExpand = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (shouldIgnoreCardToggleClick(event, contentRef.current)) {
        return;
      }

      // Only allow expand/collapse when there is overflow.
      if (!hasOverflow && !expanded) {
        return;
      }
      setExpanded(prev => !prev);
    }, [hasOverflow, expanded]);
    
    // Fill content into the input (failed state only).
    const handleFillToInput = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      globalEventBus.emit('fill-chat-input', {
        content: messageContent,
        contexts: restoredComposerContexts,
        ...(composerPresentation ? { composerPresentation } : {}),
      });
    }, [composerPresentation, messageContent, restoredComposerContexts]);

    const handleOpenUsageReport = useCallback((report: SessionUsageReport, initialTab?: SessionUsagePanelTab) => {
      void import('../../services/openSessionUsageReport').then(({ openSessionUsagePanel }) => {
        openSessionUsagePanel({
          report,
          markdown: messageContent,
          sessionId: currentSession?.sessionId ?? resolvedSessionId,
          workspacePath: currentSession?.workspacePath,
          initialTab,
          title: t('usage.title'),
          expand: true,
        });
      });
    }, [currentSession?.sessionId, currentSession?.workspacePath, messageContent, resolvedSessionId, t]);
    
    // Collapse when clicking outside.
    useEffect(() => {
      if (!expanded) return;
      
      const handleClickOutside = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          setExpanded(false);
        }
      };
      
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, [expanded]);

    // Avoid zero-size errors by rendering a placeholder instead of null.
    if (!message) {
      return <div data-openbitfun-component="user-message-item" data-openbitfun-part="root" style={{ minHeight: '1px' }} />;
    }

    if (isUsageReportMessage) {
      return (
        <SessionUsageReportCard
          report={usageReport}
          markdown={messageContent}
          generatedAt={message.metadata?.generatedAt}
          isLoading={isUsageReportLoading}
          onOpenDetails={usageReport ? handleOpenUsageReport : undefined}
        />
      );
    }

    if (isGoalLoadingMessage) {
      return (
        <div data-openbitfun-component="user-message-item" data-openbitfun-part="loading" data-openbitfun-state="loading" className="session-usage-report-card session-usage-report-card--loading" aria-live="polite">
          <div className="session-usage-report-card__loading-main">
            <ToolProcessingDots className="session-usage-report-card__loading-dots" size={12} />
            <div>
              <h3 className="session-usage-report-card__loading-title">{messageContent}</h3>
            </div>
          </div>
        </div>
      );
    }
    
    return (
      <div className="user-message-item-shell">
        <div
          data-openbitfun-component="user-message-item"
          data-openbitfun-part="root"
          data-openbitfun-state={[expanded && 'expanded', isFailed && 'failed'].filter(Boolean).join(' ') || undefined}
          ref={containerRef}
          className={`user-message-item ${expanded ? 'user-message-item--expanded' : ''}${isFailed ? ' user-message-item--failed' : ''}`}
          data-testid="chat-user-message"
          data-turn-id={turnId}
          data-status={resolvedTurnStatus || ''}
          data-failed={isFailed ? 'true' : 'false'}
        >
        {isEditing ? (
          <UserMessageEditComposer
            value={editDraft}
            isSubmitting={isEditSubmitting}
            submitLabel={t('message.saveEdit')}
            cancelLabel={t('message.cancelEdit')}
            placeholder={t('message.editPlaceholder')}
            onChange={setEditDraft}
            onSubmit={handleSubmitEdit}
            onCancel={cancelEdit}
            presentation={composerPresentation}
            workspacePath={currentSession?.workspacePath}
            workspaceId={currentSession?.workspaceId}
            remoteConnectionId={
              currentSession?.remoteConnectionId
              || currentSession?.config?.remoteConnectionId
            }
            excludeSessionId={resolvedSessionId}
          />
        ) : (
          <div className="user-message-item__main" data-openbitfun-component="user-message-item" data-openbitfun-part="main">
          <div
            className={
              isFailed
                ? 'user-message-item__failed-inline-cluster'
                : 'user-message-item__main-contents-bridge'
            }
          >
            {isFailed ? (
              <div className="user-message-item__failed-body">
                <div 
                  ref={contentRef}
                  className="user-message-item__content"
                  data-openbitfun-component="user-message-item"
                  data-openbitfun-part="content"
                  data-testid="chat-user-message-content"
                  data-turn-id={turnId}
                  onClick={handleToggleExpand}
                  title={(hasOverflow || expanded) ? (expanded ? t('message.clickToCollapse') : t('message.clickToExpand')) : undefined}
                  style={{
                    cursor: (hasOverflow || expanded) ? 'pointer' : 'text',
                  }}
                >
                  {composerPresentation ? (
                    <UserMessagePresentationContent presentation={composerPresentation} />
                  ) : <UserMessageTextContent text={displayText} />}
                </div>
                {steeringTag && (
                  <div className={`user-message-item__steering-tag ${steeringTag.className}`} data-openbitfun-component="user-message-item" data-openbitfun-part="steeringTag">
                    {steeringTag.label}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div 
                  ref={contentRef}
                  className="user-message-item__content"
                  data-openbitfun-component="user-message-item"
                  data-openbitfun-part="content"
                  data-testid="chat-user-message-content"
                  data-turn-id={turnId}
                  onClick={handleToggleExpand}
                  title={(hasOverflow || expanded) ? (expanded ? t('message.clickToCollapse') : t('message.clickToExpand')) : undefined}
                  style={{
                    cursor: (hasOverflow || expanded) ? 'pointer' : 'text',
                  }}
                >
                  {composerPresentation ? (
                    <UserMessagePresentationContent presentation={composerPresentation} />
                  ) : <UserMessageTextContent text={displayText} />}
                </div>
                {steeringTag && (
                  <div className={`user-message-item__steering-tag ${steeringTag.className}`} data-openbitfun-component="user-message-item" data-openbitfun-part="steeringTag">
                    {steeringTag.label}
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        )}

        {message.images && message.images.length > 0 && (
          <div className="user-message-item__images" data-openbitfun-component="user-message-item" data-openbitfun-part="images">
            {message.images.map(img => (
              <UserMessageImage key={img.id} image={img} onPreview={setLightboxImage} />
            ))}
          </div>
        )}

          {lightboxImage && createPortal(
            <div
              className="user-message-item__lightbox"
              onClick={() => setLightboxImage(null)}
              data-openbitfun-component="user-message-item"
              data-openbitfun-part="lightbox"
              data-openbitfun-native-webview-occlusion
            >
              <button className="user-message-item__lightbox-close" onClick={() => setLightboxImage(null)}>
                <Icon name="xmark" size="lg" style={{ width: 20, height: 20 }} />
              </button>
              <img src={lightboxImage} alt="Preview" onClick={(e) => e.stopPropagation()} />
            </div>,
            getAppearanceOverlayHost(),
          )}
        </div>

        <div className="user-message-item__meta" data-openbitfun-component="user-message-item" data-openbitfun-part="meta">
          {sentTime && sentAtLabel && sentTimestamp !== null && (
            <time
              className="user-message-item__timestamp"
              data-openbitfun-component="user-message-item"
              data-openbitfun-part="timestamp"
              data-testid="chat-user-message-timestamp"
              dateTime={new Date(sentTimestamp).toISOString()}
              title={sentAtLabel}
              aria-label={sentAtLabel}
            >
              {sentTime}
            </time>
          )}
          {!isEditing && (
            <div className="user-message-item__actions" data-openbitfun-component="user-message-item" data-openbitfun-part="actions">
              <Tooltip content={copied ? t('message.copied') : t('message.copy')}>
                <button
                  type="button"
                  className={`user-message-item__copy-btn ${copied ? 'copied' : ''}`}
                  onClick={handleCopy}
                  aria-label={copied ? t('message.copied') : t('message.copy')}
                >
                  {copied ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
                </button>
              </Tooltip>
              {canShowEditAction && (
                <Tooltip content={canEdit ? t('message.edit') : editDisabledReason}>
                  <button
                    type="button"
                    className="user-message-item__edit-btn"
                    onClick={handleBeginEdit}
                    disabled={!canEdit}
                    aria-label={canEdit ? t('message.edit') : editDisabledReason}
                  >
                    <Icon name="edit" size="sm" />
                  </button>
                </Tooltip>
              )}
              {isFailed ? (
                <Tooltip content={t('message.fillToInput')}>
                  <button
                    className="user-message-item__copy-btn"
                    onClick={handleFillToInput}
                  >
                    <Icon name="arrow-down" size="sm" />
                  </button>
                </Tooltip>
              ) : canShowRollbackAction && !steeringStatus ? (
                <Tooltip content={rollbackTooltip}>
                  <button
                    className="user-message-item__rollback-btn"
                    onClick={handleRollback}
                    disabled={!canRollback}
                    aria-label={rollbackTooltip}
                  >
                    {sessionMutation?.kind === 'rollback' && sessionMutation.targetTurnId === turnId ? (
                      <Loader2 size={14} className="user-message-item__rollback-spinner" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                  </button>
                </Tooltip>
              ) : null}
            </div>
          )}
        </div>

      </div>
    );
  }
);

UserMessageItem.displayName = 'UserMessageItem';
