import { useEffect, useRef } from 'react';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useContextStoreApi } from '@/shared/stores/contextStore';
import { appendConversationExcerpt, isConversationExcerpt, isValidConversationExcerpt, numberConversationExcerpt } from '@/shared/utils/conversationExcerpt';
import { excerptSessionFamily, queuedConversationExcerpts, sessionConversationExcerpts } from './conversationExcerptInventory';
import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import { expandSessionAuxPane } from '@/app/scenes/session/sessionPanelLayout';
import { flowChatStore } from '../store/FlowChatStore';
import { sessionComposerStore } from '../store/sessionComposerStore';
import { createBtwSessionPlaceholder } from '../services/BtwThreadService';
import { openBtwSessionInAuxPane } from '../services/btwSessionPane';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { isAcpFlowSession } from '../utils/acpSession';
import { useConversationViewScope } from '../contexts/conversationViewScope';
import { openMainSession } from '../services/sessionActivation';
import { FLOWCHAT_EXCERPT_ACTION, type ExcerptActionRequest } from './excerptActions';

/** Only the visible primary composer may commit a selection action into a session draft. */
export function useExcerptComposerActions({ mainSessionId, targetSessionId, active, setInputTarget, focus }: {
  mainSessionId: string | null;
  targetSessionId: string | null;
  active: boolean;
  setInputTarget: (target: 'main' | 'btw') => void;
  focus: () => void;
}) {
  const peer = usePeerDeviceModeOptional();
  const viewScope = useConversationViewScope();
  const contextsStore = useContextStoreApi();
  const targetRef = useRef(targetSessionId);
  targetRef.current = targetSessionId;
  useEffect(() => {
    if (!active || !mainSessionId) return;
    let frame = 0;
    const handle = async (event: Event) => {
      const request = (event as CustomEvent<ExcerptActionRequest>).detail;
      const scope = getActiveSurfaceScope();
      if (!request || request.parentSessionId !== mainSessionId || request.surfaceEpoch !== scope.epoch
        || !isValidConversationExcerpt(request.excerpt) || request.excerpt.source.surfaceId !== scope.surfaceId) return;
      const state = flowChatStore.getState();
      const parent = state.sessions.get(mainSessionId);
      const source = state.sessions.get(request.excerpt.source.sessionId);
      if (!parent || !source || (!viewScope && state.activeSessionId !== mainSessionId)
        || (source.sessionId !== mainSessionId && source.parentSessionId !== mainSessionId)) return;
      let destination = mainSessionId;
      if (request.action === 'ask') {
        if (!parent.workspacePath || isAcpFlowSession(parent) || resolveSessionDriverId(mainSessionId, parent) === 'dispatch'
          || (peer?.peerMode.active ? peer.currentPeerCapabilities?.hostKind !== 'desktop' : !isTauriRuntime())) return;
        if (source.sessionId !== mainSessionId) {
          if (source.sessionKind !== 'btw') return;
          destination = source.sessionId;
        } else {
          const draft = [...state.sessions.values()].find(session => session.sessionKind === 'btw'
            && session.parentSessionId === mainSessionId && !session.isHistorical
            && !session.btwOrigin?.requestId && session.dialogTurns.length === 0);
          destination = draft?.sessionId ?? createBtwSessionPlaceholder({
            parentSessionId: mainSessionId, workspacePath: parent.workspacePath,
            childSessionName: request.excerpt.fragments[0].text.replace(/\s+/g, ' ').trim().slice(0, 48),
            parentDialogTurnId: request.excerpt.fragments[0].turnId,
          }).childSessionId;
        }
      }
      const composer = sessionComposerStore.getState();
      const currentTargetSessionId = targetRef.current;
      const visibleContexts = contextsStore.getState().contexts;
      if (currentTargetSessionId && currentTargetSessionId !== destination) composer.setContexts(currentTargetSessionId, visibleContexts);
      const contexts = destination === currentTargetSessionId ? visibleContexts : composer.getDraft(destination).contexts;
      const known = [
        ...excerptSessionFamily(state.sessions, mainSessionId).flatMap(session => [
          ...sessionConversationExcerpts(session),
          ...queuedConversationExcerpts(pendingQueueManager.listForSurface(scope.surfaceId, session.sessionId)),
          ...composer.getDraft(session.sessionId).contexts.filter(isConversationExcerpt),
        ]),
        ...visibleContexts.filter(isConversationExcerpt),
      ].filter(excerpt => excerpt.source.surfaceId === scope.surfaceId);
      const next = appendConversationExcerpt(contexts, numberConversationExcerpt(request.excerpt, known));
      composer.setContexts(destination, next);
      if (destination === currentTargetSessionId) contextsStore.getState().replaceContexts(next);
      if (destination !== mainSessionId) {
        if (viewScope) { await openMainSession(mainSessionId); if (!scope.isCurrent()) return; }
        openBtwSessionInAuxPane({ childSessionId: destination, parentSessionId: mainSessionId,
          workspacePath: parent.workspacePath, expand: false });
        expandSessionAuxPane();
      }
      if (!viewScope || destination === mainSessionId) setInputTarget(destination === mainSessionId ? 'main' : 'btw');
      request.onAccepted?.();
      // The draft changes synchronously; focus follows React's target activation.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (scope.isCurrent()) focus(); });
    };
    window.addEventListener(FLOWCHAT_EXCERPT_ACTION, handle);
    return () => { cancelAnimationFrame(frame); window.removeEventListener(FLOWCHAT_EXCERPT_ACTION, handle); };
  }, [active, mainSessionId, setInputTarget, focus, peer, contextsStore, viewScope]);
}
