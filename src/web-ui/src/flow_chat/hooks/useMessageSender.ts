/**
 * Message sending hook.
 * Encapsulates session creation, image uploads, and message assembly.
 *
 * Image handling is fully delegated to the backend coordinator which
 * exposes a path to the image analysis tool or attaches pixels
 * directly for a multimodal model. The frontend prepares compatible attachment payloads and passes
 * ImageContextData[] through to the backend.
 */

import { useCallback } from 'react';
import { FlowChatManager } from '../services/FlowChatManager';
import { flowChatSessionConfigForCurrentWorkspace } from '@/app/utils/projectSessionWorkspace';
import { notificationService } from '@/shared/notification-system';
import type {
  ContextItem,
  ImageContext,
  SessionReferenceContext,
} from '@/shared/types/context';
import { createLogger } from '@/shared/utils/logger';
import { formatContextForPrompt } from '@/shared/utils/contextPrompt';
import { isConversationExcerpt, withConversationExcerptFallback } from '@/shared/utils/conversationExcerpt';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isBtwSessionDraft } from '../utils/modelSelectionTarget';
import { sendMessageToBtwSession } from '../services/BtwThreadService';
import { buildImagePayload } from '../utils/imagePayload';
import {
  FLOWCHAT_MESSAGE_SUBMITTED_EVENT,
  type FlowChatMessageSubmittedRequest,
} from '../events/flowchatNavigation';
import {
  composerPresentationSessionReferences,
  withConversationExcerpts,
  type ComposerPresentation,
} from '../utils/composerPresentation';
import type {
  AgentDialogTurnExecution,
  SessionPermissionMode,
} from '@/infrastructure/api/service-api/AgentAPI';
import type { PendingLargePasteMap } from '../store/sessionComposerStore';

const log = createLogger('FlowChat');

interface UseMessageSenderProps {
  /** Current session ID */
  currentSessionId?: string;
  /** Context items */
  contexts: ContextItem[];
  /** Clear contexts callback */
  onClearContexts: () => void;
  /** Success callback */
  onSuccess?: (message: string) => void;
  /** Exit template mode callback */
  onExitTemplateMode?: () => void;
  /** Selected agent type (mode) */
  currentAgentType?: string;
  /** Reconcile the composer after an explicit session-conflict retry succeeds. */
  onSessionConflictRetrySuccess?: (submission: {
    sessionId: string;
    message: string;
    contextIds: string[];
  }) => void;
  /** Capture composer state when the user explicitly starts a conflict retry. */
  onSessionConflictRetryStart?: (submission: {
    sessionId: string;
    message: string;
    contextIds: string[];
  }) => void;
  /**
   * One-off permission mode armed for the next submission only. It outranks the
   * session's own mode for that turn and is never persisted, so the session
   * returns to its own selection afterwards.
   */
  turnPermissionMode?: SessionPermissionMode | null;
  /** Disarms the one-off mode once a submission has carried it. */
  onTurnPermissionModeConsumed?: () => void;
}

interface UseMessageSenderReturn {
  /** Send a message */
  sendMessage: (
    message: string,
    options?: {
      displayMessage?: string;
      composerPresentation?: ComposerPresentation | null;
      composerDraft?: {
        value: string;
        pendingLargePastes: PendingLargePasteMap;
      };
      /** Set false when the caller already cleared the full composer synchronously. */
      clearContextsOnSuccess?: boolean;
      execution?: AgentDialogTurnExecution;
    }
  ) => Promise<void>;
  /** Whether a send is in progress */
  isSending: boolean;
}

export function useMessageSender(props: UseMessageSenderProps): UseMessageSenderReturn {
  const peer = usePeerDeviceModeOptional();
  const canSetInitialBtwModel = !peer?.peerMode.active || peer.currentPeerCapabilities?.btwInitialModelSelectionV1 === true;
  const {
    currentSessionId,
    contexts,
    onClearContexts,
    onSuccess,
    onExitTemplateMode,
    currentAgentType,
    onSessionConflictRetryStart,
    onSessionConflictRetrySuccess,
    turnPermissionMode,
    onTurnPermissionModeConsumed,
  } = props;

  const sendMessage = useCallback(async (
    message: string,
    options?: {
      displayMessage?: string;
      composerPresentation?: ComposerPresentation | null;
      composerDraft?: {
        value: string;
        pendingLargePastes: PendingLargePasteMap;
      };
      clearContextsOnSuccess?: boolean;
      execution?: AgentDialogTurnExecution;
    }
  ) => {
    if (!message.trim()) {
      return;
    }

    const surfaceScope = getActiveSurfaceScope();
    const trimmedMessage = message.trim();
    const hasExcerpts = contexts.some(isConversationExcerpt);
    const presentation = hasExcerpts
      ? withConversationExcerpts(options?.composerPresentation, contexts, options?.displayMessage ?? trimmedMessage)
      : options?.composerPresentation;
    // Strip inline `#img:<name>` tags from the AI-bound text. The rich text
    // editor inserts these when an image is pasted, but the named file does
    // not exist on disk; image bytes are sent out-of-band via `imageContexts`
    // below. Leaving the placeholder in the prompt misleads the model into
    // looking up a non-existent file. The display message keeps the tag so
    // the UI can still render the inline pill.
    const stripImageTags = (text: string): string =>
      text
        .replace(/#img:[^\s\n]+\s?/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const aiTrimmedMessage = stripImageTags(trimmedMessage);
    let sessionId = currentSessionId;
    log.debug('Send message initiated', {
      textLength: trimmedMessage.length,
      contextCount: contexts.length,
      hasSession: !!sessionId,
      agentType: currentAgentType || 'Standard',
    });

    try {
      const flowChatManager = FlowChatManager.getInstance();
      let agentTypeForSend = currentAgentType || 'Standard';
      if (options?.execution?.kind === 'fresh_external_subagent' && contexts.length > 0) {
        throw new Error('External subagent command delegation does not accept composer context');
      }

      if (!sessionId) {
        const agentType = currentAgentType || 'Standard';
        const sessionConfig = flowChatSessionConfigForCurrentWorkspace();

        sessionId = await flowChatManager.createChatSession(sessionConfig, agentType);
        agentTypeForSend =
          FlowChatManager.getInstance().getFlowChatState().sessions.get(sessionId)?.mode ||
          agentType;
        log.debug('Session created', { sessionId, agentType, effectiveAgentType: agentTypeForSend });
      } else {
        log.debug('Reusing existing session', { sessionId });
      }

      const imageContexts = contexts.filter(ctx => ctx.type === 'image') as ImageContext[];
      const presentationSessionReferences = presentation
        ? composerPresentationSessionReferences(presentation)
        : [];
      const sessionReferenceContexts = presentationSessionReferences.length > 0
        ? presentationSessionReferences
        : contexts
        .filter((context): context is SessionReferenceContext => context.type === 'session-reference')
      const sessionReferences = sessionReferenceContexts.map((context) => ({
          sessionId: context.sessionId,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          workspacePath: context.workspacePath,
          remoteConnectionId: context.remoteConnectionId,
          remoteSshHost: context.remoteSshHost,
        }));
      const userMessageMetadata =
        presentation || sessionReferences.length > 0 || turnPermissionMode
          ? {
              ...(presentation
                ? { composerPresentation: presentation }
                : {}),
              ...(sessionReferences.length > 0 ? { sessionReferences } : {}),
              // Read by the coordinator as the turn layer of
              // `turn -> session -> global default`.
              ...(turnPermissionMode ? { permission_mode: turnPermissionMode } : {}),
            }
          : undefined;
      let imagePayload: Awaited<ReturnType<typeof buildImagePayload>>;
      try {
        imagePayload = await buildImagePayload(imageContexts);
        log.debug('Image payload prepared', {
          imageCount: imageContexts.length,
          ids: imageContexts.map(img => img.id),
          pathCount: imagePayload?.imageContexts.filter(img => img.image_path).length ?? 0,
        });
      } catch (error) {
        log.error('Failed to upload clipboard images', {
          imageCount: imageContexts.filter(ctx => !ctx.isLocal && ctx.dataUrl).length,
          error: (error as Error)?.message ?? 'unknown',
        });
        notificationService.error('Image upload failed. Please try again.', { duration: 3000 });
        throw error;
      }

      let fullMessage = aiTrimmedMessage;
      const displayMessage = options?.displayMessage?.trim() || trimmedMessage;
      const displayFallback = withConversationExcerptFallback(displayMessage, contexts);

      if (contexts.length > 0) {
        const fullContextSection = contexts
          .filter(context => context.type !== 'session-reference')
          .map(formatContextForPrompt)
          .filter(Boolean)
          .join('\n');

        fullMessage = fullContextSection
          ? `${fullContextSection}\n\n${aiTrimmedMessage}`
          : aiTrimmedMessage;
      }
      // Always pass imageContexts to the backend; the coordinator decides
      // whether to expose a path to analyze_image or attach pixels directly.
      surfaceScope.assertCurrent('submit conversation excerpts');
      const targetSession = flowChatManager.getFlowChatState().sessions.get(sessionId!);
      if (targetSession && isBtwSessionDraft(targetSession)) {
        const parentSessionId = targetSession.parentSessionId;
        if (!parentSessionId) throw new Error('Side question is missing its parent session');
        await flowChatManager.ensureBackendSession(parentSessionId);
        surfaceScope.assertCurrent('prepare side question parent');
        await sendMessageToBtwSession({ parentSessionId, childSessionId: targetSession.sessionId,
          question: fullMessage, imagePayload, modelId: targetSession.config.modelName,
          userMessageMetadata,
          ...(canSetInitialBtwModel ? { initialModelSelection: {
            modelId: targetSession.config.modelName || 'primary',
            reasoningPreset: targetSession.config.reasoningPreset,
          } } : {}),
          requestId: targetSession.btwOrigin?.requestId,
        });
      } else await flowChatManager.sendMessage(
        fullMessage,
        sessionId || undefined,
        displayFallback,
        agentTypeForSend,
        undefined,
        {
          ...(imagePayload ?? {}),
          pendingQueueDraft: {
            value: options?.composerDraft?.value ?? displayMessage,
            contexts: [...contexts],
            pendingLargePastes: { ...(options?.composerDraft?.pendingLargePastes ?? {}) },
          },
          ...(userMessageMetadata ? { userMessageMetadata } : {}),
          ...(options?.execution ? { execution: options.execution } : {}),
          onSessionConflictRetryStart: () => {
            onSessionConflictRetryStart?.({
              sessionId: sessionId!,
              message: displayMessage,
              contextIds: contexts.map(context => context.id),
            });
          },
          onSessionConflictRetrySuccess: () => {
            onSessionConflictRetrySuccess?.({
              sessionId: sessionId!,
              message: displayMessage,
              contextIds: contexts.map(context => context.id),
            });
          },
        }
      );

      if (!surfaceScope.isCurrent()) return;
      if (options?.clearContextsOnSuccess !== false) {
        onClearContexts();
      }

      // The one-off mode belongs to the submission that just left, not to the
      // next one the user types.
      if (turnPermissionMode) {
        onTurnPermissionModeConsumed?.();
      }
      onExitTemplateMode?.();

      onSuccess?.(trimmedMessage);
      /*
       * The transcript may be showing a history window this Turn is not in, and
       * only the submission knows that showing it was asked for. Announced
       * rather than returned: the composer and the transcript are siblings, and
       * every host that sends through this hook gets the behaviour.
       */
      window.dispatchEvent(new CustomEvent<FlowChatMessageSubmittedRequest>(
        FLOWCHAT_MESSAGE_SUBMITTED_EVENT,
        { detail: { sessionId } },
      ));
      log.info('Message sent successfully', {
        sessionId,
        agentType: agentTypeForSend,
        contextCount: contexts.length,
        imageCount: imageContexts.length,
      });
    } catch (error) {
      log.error('Failed to send message', {
        sessionId,
        agentType: currentAgentType || 'Standard',
        contextCount: contexts.length,
        error: (error as Error)?.message ?? 'unknown',
      });
      throw error;
    }
  }, [
    canSetInitialBtwModel,
    currentSessionId,
    contexts,
    onClearContexts,
    onSuccess,
    onExitTemplateMode,
    currentAgentType,
    onSessionConflictRetryStart,
    onSessionConflictRetrySuccess,
    turnPermissionMode,
    onTurnPermissionModeConsumed,
  ]);

  return {
    sendMessage,
    isSending: false,
  };
}
