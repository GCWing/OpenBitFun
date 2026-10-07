import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowGroupReceiveFeedback } from '@openbitfun/ui/flow-chat';
import type { VirtualItem } from '../../types/flow-chat-projection';
import { indexFlowGroups } from '../../grouping/selectors';
import { getFlowGroupStateIds, isFlowGroupExpanded } from '../../grouping/types';
import { captureFlowGroupFeedbackSnapshot, collectFlowGroupReceiveFeedback } from '../../grouping/receiveFeedback';

/** Host-scoped choices outlive virtual rows. Existing saved map keys remain valid. */
export function useFlowGroupState(
  virtualItems: VirtualItem[], initialStates?: Map<string, boolean>, sessionId?: string,
  initialExpandedToolCapsules?: ReadonlySet<string>,
  feedbackScope = sessionId,
) {
  const [groupStates, setGroupStates] = useState(() => initialStates ?? new Map<string, boolean>());
  const [expandedToolCapsules, setExpandedToolCapsules] = useState<ReadonlySet<string>>(() => initialExpandedToolCapsules ?? new Set());
  const [groupReceiveFeedback, setGroupReceiveFeedback] = useState<ReadonlyMap<string, FlowGroupReceiveFeedback>>(() => new Map());
  const previousFeedback = useRef<ReturnType<typeof captureFlowGroupFeedbackSnapshot>>();
  const index = useMemo(() => indexFlowGroups(virtualItems), [virtualItems]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    const receipts = collectFlowGroupReceiveFeedback(previousFeedback.current, virtualItems, feedbackScope);
    previousFeedback.current = captureFlowGroupFeedbackSnapshot(virtualItems, feedbackScope);
    setGroupReceiveFeedback(current => receipts.size || current.size ? receipts : current);
  }, [feedbackScope, virtualItems]);

  const onGroupToggle = useCallback((groupId: string) => {
    const location = indexRef.current.byId.get(groupId);
    const ids = location ? getFlowGroupStateIds(location.group) : [groupId];
    setGroupStates(previous => {
      const expanded = location ? isFlowGroupExpanded(location.group, previous) : previous.get(groupId) === true;
      const next = new Map(previous);
      ids.forEach(id => next.set(id, !expanded));
      return next;
    });
  }, []);

  const onExpandGroup = useCallback((groupId: string) => {
    setGroupStates(previous => {
      if (previous.get(groupId) === true) return previous;
      return new Map(previous).set(groupId, true);
    });
  }, []);

  const onExpandAllInTurn = useCallback((turnId: string) => {
    const groups = indexRef.current.byTurnId.get(turnId) ?? [];
    setGroupStates(previous => {
      const next = new Map(previous);
      groups.forEach(({ group }) => next.set(group.groupId, true));
      return next;
    });
  }, []);

  const onCollapseGroup = useCallback((groupId: string) => {
    const location = indexRef.current.byId.get(groupId);
    const ids = location ? getFlowGroupStateIds(location.group) : [groupId];
    // A parent fold changes only the parent. Child disclosure is a reader
    // choice and is restored when the collection is opened again.
    setGroupStates(previous => {
      const next = new Map(previous);
      ids.forEach(id => next.set(id, false));
      return next;
    });
  }, []);

  const onToolCapsuleExpandedChange = useCallback((key: string, expanded: boolean) => {
    setExpandedToolCapsules(previous => {
      if (previous.has(key) === expanded) return previous;
      const next = new Set(previous);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  return { groupStates, groupReceiveFeedback, onGroupToggle, onExpandGroup, onExpandAllInTurn,
    onCollapseGroup, expandedToolCapsules, onToolCapsuleExpandedChange };
}
