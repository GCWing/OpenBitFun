import { globalEventBus } from '@/infrastructure/event-bus';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest } from '../events/flowchatNavigation';
import { flowChatStore } from '../store/FlowChatStore';
import { SELECTION_ROOT, findExcerptSource, resolveExcerptRange } from './flowChatSelection';
import { createFlowChatHighlightOwner } from './flowChatHighlights';

export function findExcerptTextRoot(excerpt: ConversationExcerptContext): HTMLElement | null {
  const root = Array.from(document.querySelectorAll<HTMLElement>(SELECTION_ROOT))
    .find(node => node.dataset.flowchatSelectionRoot === excerpt.source.sessionId && node.getClientRects().length > 0);
  if (!root) return null;
  return findExcerptSource(root, excerpt.fragments[0]);
}

const lastHighlights = new WeakMap<Document, () => void>();
export function highlightExcerptRange(range: Range): () => void {
  const document = range.startContainer.ownerDocument;
  if (!document) return () => undefined;
  lastHighlights.get(document)?.();
  const owner = createFlowChatHighlightOwner(document, 'excerpt');
  owner.update([range]);
  const clear = () => {
    owner.dispose();
    if (lastHighlights.get(document) === clear) lastHighlights.delete(document);
  };
  lastHighlights.set(document, clear);
  return clear;
}

export function highlightLocatedExcerpt(excerpt: ConversationExcerptContext): boolean {
  const root = findExcerptTextRoot(excerpt);
  const range = root && resolveExcerptRange(root, excerpt.fragments[0]);
  if (!range) return false;
  const clear = highlightExcerptRange(range);
  window.setTimeout(clear, 1800);
  return true;
}

let locateRequest = 0;
export async function locateConversationExcerpt(excerpt: ConversationExcerptContext, onUnavailable: () => void): Promise<void> {
  const request = ++locateRequest;
  const scope = getActiveSurfaceScope();
  const isCurrent = () => scope.isCurrent() && request === locateRequest;
  const source = flowChatStore.getState().sessions.get(excerpt.source.sessionId);
  if (scope.surfaceId !== excerpt.source.surfaceId || !source) return onUnavailable();
  const mainSessionId = source.parentSessionId || source.sessionId;
  const isSourceActive = () => isCurrent() && flowChatStore.getState().activeSessionId === mainSessionId;
  try {
    const { openMainSession } = await import('../services/sessionActivation');
    if (!isCurrent()) return;
    await openMainSession(mainSessionId, { isCurrent });
    if (!isSourceActive()) return;
    if (source.parentSessionId) {
      const { openBtwSessionInAuxPane } = await import('../services/btwSessionPane');
      const { expandSessionAuxPane } = await import('@/app/scenes/session/sessionPanelLayout');
      if (!isSourceActive()) return;
      openBtwSessionInAuxPane({ childSessionId: source.sessionId, parentSessionId: source.parentSessionId,
        workspacePath: source.workspacePath, expand: false });
      expandSessionAuxPane();
    }
    const fragment = excerpt.fragments[0];
    // Wait for the real mounted viewport; an inactive AuxPane unmounts its listeners.
    const startedAt = performance.now();
    const dispatch = () => {
      if (!isSourceActive()) return;
      const mounted = Array.from(document.querySelectorAll<HTMLElement>(SELECTION_ROOT))
        .some(node => node.dataset.flowchatSelectionRoot === source.sessionId
          && node.dataset.flowchatExcerptReady === source.sessionId && node.getClientRects().length > 0);
      if (!mounted) {
        if (performance.now() - startedAt < 2000) requestAnimationFrame(dispatch);
        else onUnavailable();
        return;
      }
      globalEventBus.emit<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, {
        sessionId: source.sessionId, turnId: fragment.turnId, itemId: fragment.flowItemId,
        excerpt, embedded: !!source.parentSessionId, surfaceEpoch: scope.epoch, onUnavailable,
      });
    };
    requestAnimationFrame(dispatch);
  } catch {
    if (isCurrent()) onUnavailable();
  }
}
