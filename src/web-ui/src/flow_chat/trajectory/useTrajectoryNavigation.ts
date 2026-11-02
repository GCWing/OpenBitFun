import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '../store/FlowChatStore';
import type { VirtualItem } from '../store/modernFlowChatStore';
import type { Session, SessionHistoryPresentation } from '../types/flow-chat';
import type { VirtualMessageListRef } from '../components/modern/VirtualMessageList';
import { resolveFlowChatFocusTarget } from '../components/modern/flowChatFocusTarget';
import { highlightFlowChatFocusTarget } from '../components/modern/useFlowChatSearchPresentation';
import { buildFlowChatSearchMatches } from '../components/modern/useFlowChatSearch';
import { openTrajectoryPanel } from './trajectoryPanel';
import type { TrajectorySelection } from './TrajectoryExplorer';

export function useTrajectoryNavigation({ session, items, listRef, rootRef, present, expand, viewId, selectionClearRequest = 0 }: {
  session: Session | null; items: VirtualItem[]; listRef: RefObject<VirtualMessageListRef | null>;
  rootRef: RefObject<HTMLElement | null>; present: (sessionId: string, presentation: SessionHistoryPresentation) => void;
  expand: (id: string) => void; viewId: string;
  selectionClearRequest?: number;
}) {
  const { t } = useI18n('flow-chat');
  const generation = useRef(0);
  const latest = useRef({ session, items, present, expand });
  const cancelPending = useRef<(() => void) | undefined>(undefined);
  const clearHighlight = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => { latest.current = { session, items, present, expand }; });
  useEffect(() => {
    const cancel = () => { generation.current++; cancelPending.current?.(); clearHighlight.current?.(); };
    const root = rootRef.current;
    root?.addEventListener('wheel', cancel, { passive: true });
    root?.addEventListener('touchstart', cancel, { passive: true });
    root?.addEventListener('pointerdown', cancel);
    root?.addEventListener('keydown', cancel);
    return () => {
      cancel(); root?.removeEventListener('wheel', cancel); root?.removeEventListener('touchstart', cancel);
      root?.removeEventListener('pointerdown', cancel); root?.removeEventListener('keydown', cancel);
    };
  }, [rootRef, session?.sessionId, selectionClearRequest]);
  return useCallback(async ({ node, query }: TrajectorySelection): Promise<boolean> => {
    const activeSession = latest.current.session;
    if (!activeSession) return false;
    const source = activeSession;
    const scope = getActiveSurfaceScope();
    cancelPending.current?.();
    const ticket = ++generation.current;
    const current = () => scope.isCurrent() && generation.current === ticket
      && latest.current.session?.sessionId === source.sessionId;
    clearHighlight.current?.();
    listRef.current?.prepareItemNavigation();
    if (!latest.current.items.some(item => item.turnId === node.turnId)) {
      if (scope.surfaceId !== 'local') {
        // Peer transcript content remains owned by the canonical record replica.
        // Read only until the requested stable Turn appears, never a second
        // persisted-body RPC or an unconditional full-history drain.
        let peerSession = flowChatStore.getState().sessions.get(source.sessionId);
        while (current() && !peerSession?.dialogTurns.some(turn => turn.id === node.turnId) && peerSession?.isPartial) {
          const advanced = await flowChatStore.loadOlderRelaySessionHistory(source.sessionId);
          if (!current()) return false;
          peerSession = flowChatStore.getState().sessions.get(source.sessionId);
          if (!advanced) break;
        }
        if (!current()) return false;
        const index = peerSession?.dialogTurns.findIndex(turn => turn.id === node.turnId) ?? -1;
        if (!peerSession || index < 0) return false;
        const start = Math.max(0, index - 4);
        const turns = peerSession.dialogTurns.slice(start, index + 9);
        const ordinal = Math.max(0, node.turnOrdinal - (index - start));
        latest.current.present(source.sessionId, { turns, range: {
          mode: 'history-window', targetTurnId: node.turnId, startOrdinal: ordinal,
          endOrdinalExclusive: ordinal + turns.length,
        } });
      } else {
        const result = await flowChatStore.loadSessionTurnWindow(source.sessionId, node.turnOrdinal, { source: 'target' });
        if (!current() || result.status !== 'ready' || !result.isCurrent || result.targetTurnId !== node.turnId) return false;
        const presentation = flowChatStore.activateSessionHistoryWindow(source.sessionId, result.targetOrdinal, result.navigationGeneration);
        if (!presentation) return false;
        latest.current.present(source.sessionId, presentation);
      }
    }
    if (!current()) return false;
    // Let the pane resize before measuring the target; commit its content on success.
    window.dispatchEvent(new CustomEvent('expand-right-panel'));
    const started = performance.now();
    return new Promise<boolean>(resolve => {
      let settled = false;
      let frame: number | undefined;
      const timeout = setTimeout(() => finish(false), 5000);
      function finish(value: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (cancelPending.current === cancel) cancelPending.current = undefined;
        const accepted = value && current();
        if (!accepted) listRef.current?.clearSearchMatch();
        if (accepted) openTrajectoryPanel(source, node, query, t('trajectory.details'), viewId);
        resolve(accepted);
      }
      function cancel() { finish(false); }
      cancelPending.current = cancel;
      function retry() { frame = requestAnimationFrame(attempt); }
      function attempt() {
        if (settled) return;
        if (!current() || performance.now() - started > 5000) { finish(false); return; }
        const values = latest.current.items;
        const turnSources = values.flatMap((item, index) => item.turnId === node.turnId ? [{ item, index }] : []);
        const target = resolveFlowChatFocusTarget({ sessionId: source.sessionId, turnId: node.turnId,
          itemId: node.focusItemId ?? undefined }, turnSources.map(source => source.item));
        if (target.expandExploreGroupId) latest.current.expand(target.expandExploreGroupId);
        const ownerIndex = values.findIndex(item => item.turnId === node.turnId && (
          item.type === 'background-run'
          || node.kind === 'user' && (node.focusItemId ? item.type === 'user-steering-message' && item.data.id === node.focusItemId : item.type === 'user-message')
          || item.type === 'model-round' && (item.data.id === node.roundId || item.data.historyRounds?.some(round => round.id === node.roundId))
        ));
        const resolved = target.resolvedVirtualIndex !== undefined ? turnSources[target.resolvedVirtualIndex]?.index : undefined;
        const index = resolved ?? ownerIndex;
        if (index < 0 || !listRef.current) { retry(); return; }
        const match = node.matchField === 'content' && query.trim()
          ? buildFlowChatSearchMatches(values, query).find(match => match.turnId === node.turnId
            && (node.kind === 'user' ? match.virtualItemIndex === index : match.flowItemId === node.focusItemId)) : undefined;
        if (match) {
          listRef.current.scrollToSearchMatch({ ...match, query, isCurrent: () => !settled && current(),
            onLocated: element => {
              if (!settled && current()) clearHighlight.current = highlightFlowChatFocusTarget(element);
              finish(current());
            }, onUnavailable: () => finish(false) });
          return;
        }
        const element = listRef.current.focusItem({ virtualItemIndex: index, turnId: node.turnId,
          flowItemId: node.kind === 'user' ? undefined : node.focusItemId ?? undefined, roundId: node.roundId ?? undefined });
        if (!element) { retry(); return; }
        clearHighlight.current = highlightFlowChatFocusTarget(element);
        finish(true);
      }
      retry();
    });
  }, [listRef, t, viewId]);
}
