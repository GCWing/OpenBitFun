import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { FlowChatStore } from '../store/FlowChatStore';
import { selectActiveBtwSessionTab, type BtwSessionPanelData } from '../services/btwSessionPane';
import { getSessionConversationCapability } from '../session-drivers/conversationCapability';
import { sessionDriverOwnershipSources } from '../session-drivers/registry';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import type { Session } from '../types/flow-chat';
import {
  resolveComposerTargets,
  type ChatInputTarget,
  type ComposerTargetCandidate,
  type ComposerTargetSelection,
} from '../utils/chatInputTarget';

const ownershipSources = sessionDriverOwnershipSources();

function subscribeToDriverOwnership(listener: () => void): () => void {
  const dispose = ownershipSources.map(source => source.subscribe(listener));
  return () => dispose.forEach(unsubscribe => unsubscribe());
}

function candidatesFor(
  mainId: string | null,
  child: BtwSessionPanelData | undefined,
  sessions: ReadonlyMap<string, Session>,
): ComposerTargetCandidate[] {
  const candidates: ComposerTargetCandidate[] = mainId ? [{
    sessionId: mainId,
    role: 'main',
    conversation: getSessionConversationCapability(mainId, sessions.get(mainId)),
  }] : [];
  if (child && child.parentSessionId === mainId && child.childSessionId !== mainId) {
    candidates.push({
      sessionId: child.childSessionId,
      role: 'btw',
      readOnly: child.viewKind === 'review-check',
      conversation: getSessionConversationCapability(child.childSessionId, sessions.get(child.childSessionId)),
    });
  }
  return candidates;
}

/** One owner for pointer, keyboard and programmatic composer target selection. */
export function useChatInputTargets(options: {
  currentSessionId: string | null;
  activeChild: BtwSessionPanelData | undefined;
  sessions: ReadonlyMap<string, Session>;
  auxiliaryEnabled: boolean;
}) {
  const surfaceId = getActiveSurfaceScope().surfaceId;
  // Driver ownership may arrive before the corresponding session projection.
  const readOwnership = () => [options.currentSessionId, options.activeChild?.childSessionId]
    .map(id => id ? resolveSessionDriverId(id, options.sessions.get(id)) : '').join('|');
  useSyncExternalStore(subscribeToDriverOwnership, readOwnership, readOwnership);
  const [requested, setRequested] = useState<ComposerTargetSelection | null>(null);
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const resolution = resolveComposerTargets({
    surfaceId,
    currentSessionId: options.currentSessionId,
    requested,
    candidates: candidatesFor(options.currentSessionId, options.activeChild, options.sessions),
  });

  // Resolve synchronously in render; cleanup only prevents a removed selection
  // from reviving when a closed pane or an unavailable child reappears later.
  useLayoutEffect(() => {
    if (requested && (requested.surfaceId !== surfaceId
      || requested.parentSessionId !== options.currentSessionId
      || requested.sessionId !== resolution.effectiveSessionId)) {
      requestedRef.current = null;
      setRequested(null);
    }
  }, [options.currentSessionId, requested, resolution.effectiveSessionId, surfaceId]);

  const resolveLive = useCallback(() => {
    const current = optionsRef.current;
    const state = FlowChatStore.getInstance().getState();
    const tab = current.auxiliaryEnabled
      ? selectActiveBtwSessionTab(useAgentCanvasStore.getState()) : null;
    return resolveComposerTargets({
      surfaceId: getActiveSurfaceScope().surfaceId,
      currentSessionId: current.currentSessionId,
      requested: requestedRef.current,
      candidates: candidatesFor(current.currentSessionId,
        tab?.content.data as BtwSessionPanelData | undefined, state.sessions),
    });
  }, []);

  const selectTargetSession = useCallback((sessionId: string) => {
    const current = optionsRef.current;
    if (!resolveLive().targets.some(target => target.sessionId === sessionId)) return;
    const selection = { surfaceId: getActiveSurfaceScope().surfaceId,
      parentSessionId: current.currentSessionId, sessionId };
    requestedRef.current = selection;
    setRequested(selection);
  }, [resolveLive]);

  const selectTarget = useCallback((role: ChatInputTarget) => {
    const target = resolveLive().targets.find(candidate => candidate.role === role);
    if (target) selectTargetSession(target.sessionId);
  }, [resolveLive, selectTargetSession]);

  const isTargetCurrent = useCallback((sessionId: string | null) => {
    const current = optionsRef.current;
    if (current.auxiliaryEnabled
      && FlowChatStore.getInstance().getState().activeSessionId !== current.currentSessionId) return false;
    const live = resolveLive();
    return live.effectiveSessionId === sessionId && live.canSubmit;
  }, [resolveLive]);

  return { ...resolution, inputTarget: resolution.selected?.role ?? 'main',
    selectTarget, selectTargetSession, isTargetCurrent };
}
