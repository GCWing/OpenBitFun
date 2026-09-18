/**
 * FlowChat navigation side effects.
 *
 * Handles cross-session focus requests for the modern virtualized list.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import { useConversationDockStore, dockConversationKey } from '@/app/stores/conversationDockStore';
import { useConversationViewScope } from '../../contexts/conversationViewScope';
import { flowChatStore } from '../../store/FlowChatStore';
import { useModernFlowChatStoreApi, type VirtualItem } from '../../store/modernFlowChatStore';
import { flowChatManager } from '../../services/FlowChatManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  FLOWCHAT_FOCUS_ITEM_EVENT,
  type FlowChatFocusItemRequest,
} from '../../events/flowchatNavigation';
import type { VirtualMessageListRef } from './VirtualMessageList';
import { resolveFlowChatFocusTarget, type ResolvedFocusTarget } from './flowChatFocusTarget';

const log = createLogger('useFlowChatNavigation');

interface UseFlowChatNavigationOptions {
  containerRef: RefObject<HTMLElement | null>;
  isViewportActive?: boolean;
  activeSessionId?: string;
  virtualItems: VirtualItem[];
  virtualListRef: RefObject<VirtualMessageListRef | null>;
  onExpandExploreGroup?: (groupId: string) => void;
  onNavigateToFocusTurn?: (request: FlowChatFocusItemRequest) => Promise<boolean> | boolean;
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  return predicate();
}

function navigateToResolvedTarget(
  virtualListRef: RefObject<VirtualMessageListRef | null>,
  target: ResolvedFocusTarget,
  options?: { allowLocalTurnIndex?: boolean },
): void {
  const list = virtualListRef.current;
  if (!list) return;

  if (target.preferTurnNavigation && target.resolvedTurnId) {
    list.navigateToTurn(target.resolvedTurnId, { behavior: 'auto' });
    return;
  }

  if (target.resolvedVirtualIndex != null) {
    list.scrollToIndex(target.resolvedVirtualIndex);
    return;
  }

  if (options?.allowLocalTurnIndex !== false && target.resolvedTurnIndex) {
    list.scrollToTurn(target.resolvedTurnIndex);
  }
}

export function useFlowChatNavigation({
  containerRef,
  isViewportActive = true,
  activeSessionId,
  virtualItems,
  virtualListRef,
  onExpandExploreGroup,
  onNavigateToFocusTurn,
}: UseFlowChatNavigationOptions): void {
  const viewScope = useConversationViewScope();
  const modernStore = useModernFlowChatStoreApi();
  const virtualItemsRef = useRef(virtualItems);
  const onExpandExploreGroupRef = useRef(onExpandExploreGroup);
  const onNavigateToFocusTurnRef = useRef(onNavigateToFocusTurn);

  useLayoutEffect(() => {
    virtualItemsRef.current = virtualItems;
    onExpandExploreGroupRef.current = onExpandExploreGroup;
    onNavigateToFocusTurnRef.current = onNavigateToFocusTurn;
  }, [onExpandExploreGroup, onNavigateToFocusTurn, virtualItems]);

  useEffect(() => {
    let excerptGeneration = 0;
    let disposed = false;
    const cancelExcerpt = () => { excerptGeneration++; };
    window.addEventListener('wheel', cancelExcerpt, { passive: true });
    window.addEventListener('pointerdown', cancelExcerpt);
    window.addEventListener('keydown', cancelExcerpt);
    const handleRequest = async (request: FlowChatFocusItemRequest) => {
      const { sessionId, itemId } = request;
      if (!sessionId || (viewScope && viewScope.sessionId !== sessionId)) return;
      if (request.embedded) return;
      const scope = getActiveSurfaceScope();
      if (request.surfaceEpoch !== undefined && request.surfaceEpoch !== scope.epoch) return;
      if (!viewScope) {
        const dock = useConversationDockStore.getState();
        const target = dock.entries.find(entry => entry.surfaceId === scope.surfaceId && entry.sessionId === sessionId);
        if (target) { dock.select(dockConversationKey(target)); dock.setOpen(true); return; }
      }
      const generation = ++excerptGeneration;
      const isCurrent = () => !disposed && generation === excerptGeneration && scope.isCurrent()
        && modernStore.getState().activeSession?.sessionId === sessionId;

      if (activeSessionId !== sessionId) {
        try {
          await flowChatManager.switchChatSession(sessionId);
        } catch (error) {
          log.warn('Failed to switch session for focus request', { sessionId, error });
          return;
        }
      }

      const ready = await waitForCondition(() => {
        const modernActiveSessionId = modernStore.getState().activeSession?.sessionId;
        return modernActiveSessionId === sessionId && !!virtualListRef.current;
      }, 1500);
      if (!ready) {
        log.warn('FlowChat focus target did not become active before timeout', { sessionId });
        if (request.excerpt && isCurrent()) request.onUnavailable?.();
        return;
      }

      if (request.excerpt) {
        if (!isCurrent()) return;
        const excerpt = request.excerpt;
        const fragment = excerpt.fragments[0];
        const findIndex = () => fragment.flowItemId
          ? resolveFlowChatFocusTarget(request, virtualItemsRef.current, flowChatStore.getState().sessions.get(sessionId)).resolvedVirtualIndex
          : virtualItemsRef.current.findIndex(item => item.type === 'user-message' && item.turnId === fragment.turnId);
        try {
          if ((findIndex() ?? -1) < 0) await onNavigateToFocusTurnRef.current?.(request);
        } catch (error) {
          log.warn('Failed to load the selected excerpt source', { sessionId, error });
          if (isCurrent()) request.onUnavailable?.();
          return;
        }
        const found = await waitForCondition(() => {
          if (!isCurrent()) return true;
          const index = findIndex();
          if (index === undefined || index < 0 || !virtualListRef.current) return false;
          const target = resolveFlowChatFocusTarget(request, virtualItemsRef.current, flowChatStore.getState().sessions.get(sessionId));
          if (target.expandExploreGroupId) onExpandExploreGroupRef.current?.(target.expandExploreGroupId);
          virtualListRef.current?.scrollToSearchMatch({ virtualItemIndex: index, query: fragment.text,
            flowItemId: fragment.flowItemId, excerpt, isCurrent,
            onUnavailable: () => { if (isCurrent()) request.onUnavailable?.(); } });
          return true;
        }, 2000);
        if (!found && isCurrent()) request.onUnavailable?.();
        return;
      }

      const delegatedTurnNavigationAttempted = Boolean(
        (request.turnId || request.turnIndex)
        && onNavigateToFocusTurnRef.current,
      );
      let delegatedTurnNavigation = false;
      if (delegatedTurnNavigationAttempted && onNavigateToFocusTurnRef.current) {
        try {
          delegatedTurnNavigation = await onNavigateToFocusTurnRef.current(request);
        } catch (error) {
          log.warn('Failed to navigate to the requested FlowChat Turn window', {
            sessionId,
            turnId: request.turnId,
            turnIndex: request.turnIndex,
            error,
          });
        }
      }

      const targetSession = flowChatStore.getState().sessions.get(sessionId);
      const resolvedTarget = resolveFlowChatFocusTarget(
        request,
        virtualItemsRef.current,
        targetSession,
      );

      if (!delegatedTurnNavigation) {
        if (resolvedTarget.expandExploreGroupId) {
          onExpandExploreGroupRef.current?.(resolvedTarget.expandExploreGroupId);
        }
        navigateToResolvedTarget(virtualListRef, resolvedTarget, {
          // A focus request carries an absolute Session Turn index. Once the
          // container-owned catalog/window transaction has handled that
          // coordinate, it must never be reused as an index into the current
          // partial presentation. Stable ids and already-rendered item indexes
          // remain safe fallbacks.
          allowLocalTurnIndex: !delegatedTurnNavigationAttempted,
        });
      }

      if (!itemId) return;

      const maxAttempts = 120;
      let attempts = 0;
      let expandedExploreGroupId: string | null = null;
      const tryFocus = () => {
        if (!isCurrent()) return;
        attempts += 1;
        const currentTarget = resolveFlowChatFocusTarget(
          request,
          virtualItemsRef.current,
          flowChatStore.getState().sessions.get(sessionId),
        );
        if (
          currentTarget.expandExploreGroupId
          && currentTarget.expandExploreGroupId !== expandedExploreGroupId
        ) {
          expandedExploreGroupId = currentTarget.expandExploreGroupId;
          onExpandExploreGroupRef.current?.(currentTarget.expandExploreGroupId);
        }
        const focusItemId = currentTarget.focusItemId ?? itemId;
        const element = containerRef.current?.querySelector<HTMLElement>(`[data-flow-item-id="${CSS.escape(focusItemId)}"]`);
        if (!element || !virtualListRef.current?.focusFlowItem(focusItemId)) {
          if (
            attempts % 12 === 0
            && !delegatedTurnNavigationAttempted
            && !currentTarget.preferTurnNavigation
          ) {
            navigateToResolvedTarget(virtualListRef, currentTarget);
          }
          if (attempts < maxAttempts) {
            requestAnimationFrame(tryFocus);
          }
          return;
        }

        element.classList.add('flowchat-flow-item--focused');
        window.setTimeout(() => element.classList.remove('flowchat-flow-item--focused'), 1600);
      };

      /*
       * Tried in this task before yielding a frame, because the Turn navigation
       * above has already placed the viewport and every frame between the two
       * placements is one the reader watches the transcript land and jump
       * again. Measured from two usage-report clicks: the Turn navigation
       * settled 178px and 334.7px away from where it put itself, because this
       * aim arrived 41ms — three frames — later, and the intermediate position
       * was painted (`nextFramePx` equalled it both times).
       *
       * When the item is not rendered yet the retry loop below is unchanged,
       * and the Turn placement is what the reader looks at until it is. That
       * part is unavoidable: something has to be on screen while we wait.
       */
      tryFocus();
    };
    // The shell retains requests while a dock view is mounting or hidden. Taking
    // one after activation avoids rebroadcasts and duplicate navigation writers.
    const drainDockRequest = () => {
      if (!viewScope || !isViewportActive) return;
      const key = dockConversationKey(viewScope);
      const dock = useConversationDockStore.getState();
      const request = dock.focusRequests[key];
      if (!request) return;
      dock.consumeFocus(key, request);
      void handleRequest(request);
    };
    const unsubscribe = viewScope
      ? useConversationDockStore.subscribe(drainDockRequest)
      : globalEventBus.on<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, handleRequest);
    drainDockRequest();

    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener('wheel', cancelExcerpt);
      window.removeEventListener('pointerdown', cancelExcerpt);
      window.removeEventListener('keydown', cancelExcerpt);
    };
  }, [activeSessionId, containerRef, virtualListRef, viewScope, modernStore, isViewportActive]);
}
