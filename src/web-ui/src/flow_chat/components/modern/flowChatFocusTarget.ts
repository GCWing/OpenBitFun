import type { FlowChatFocusItemRequest } from '../../events/flowchatNavigation';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { Session } from '../../types/flow-chat';
import { getProjectedModelRoundGroups } from '../../grouping/roundGroups';
import { indexFlowGroups } from '../../grouping/selectors';
import { findElementWithDataValue } from './flowChatSearchDom';
import {
  absoluteSessionTurnIndexForId,
  absoluteSessionTurnIndexForLocalIndex,
  loadedSessionTurnIdForAbsoluteIndex,
} from '../../utils/flowChatTurnOrdinal';

export interface ResolvedFocusTarget {
  resolvedVirtualIndex?: number;
  resolvedTurnId?: string;
  resolvedTurnIndex?: number;
  focusItemId?: string;
  expandExploreGroupId?: string;
  preferTurnNavigation: boolean;
}

/** Settled thinking shares the visible row of its successor; its own box is empty. */
export function findFlowChatFocusElement(container: HTMLElement, itemId: string): HTMLElement | null {
  const element = findElementWithDataValue(container, 'data-flow-item-id', itemId)
    ?? findElementWithDataValue(container, 'data-tool-card-id', itemId);
  const successor = element?.nextElementSibling;
  return element?.dataset.thinkingAttachment === 'side'
    && successor instanceof HTMLElement && successor.hasAttribute('data-thinking-continuation')
    ? successor : element;
}

export function resolveFlowChatFocusTarget(
  request: FlowChatFocusItemRequest,
  currentVirtualItems: VirtualItem[],
  targetSession?: Session,
): ResolvedFocusTarget {
  const { turnIndex, itemId, source } = request;
  let resolvedVirtualIndex: number | undefined = undefined;
  let resolvedTurnIndex = turnIndex;
  let resolvedTurnId = request.turnId?.trim() || undefined;
  let expandExploreGroupId: string | undefined = undefined;

  if (targetSession && turnIndex && turnIndex >= 1 && !resolvedTurnId) {
    resolvedTurnId = loadedSessionTurnIdForAbsoluteIndex(targetSession, turnIndex);
  }
  if (targetSession && resolvedTurnId && resolvedTurnIndex === undefined) {
    resolvedTurnIndex = absoluteSessionTurnIndexForId(targetSession, resolvedTurnId);
  }

  if (itemId) {
    if (targetSession) {
      for (let i = 0; i < targetSession.dialogTurns.length; i += 1) {
        const turn = targetSession.dialogTurns[i];
        const found = turn.modelRounds?.some(round => round.items?.some(item => item.id === itemId));
        if (found) {
          resolvedTurnIndex = absoluteSessionTurnIndexForLocalIndex(targetSession, i);
          resolvedTurnId = turn.id;
          break;
        }
      }
    }

    const owner = indexFlowGroups(currentVirtualItems).byMemberId.get(itemId);
    if (owner) {
      resolvedVirtualIndex = owner.virtualIndex;
      resolvedTurnId = resolvedTurnId ?? owner.turnId;
      expandExploreGroupId = owner.group.groupId;
    }
    for (let i = 0; !owner && i < currentVirtualItems.length; i += 1) {
      const item = currentVirtualItems[i];
      if (item.type === 'model-round') {
        const group = getProjectedModelRoundGroups(item).find(candidate => candidate.type === 'critical'
          && candidate.item.id === itemId);
        const hit = group || item.canvasArtifactItems?.some(member => member.id === itemId);
        if (hit) {
          resolvedVirtualIndex = i;
          resolvedTurnId = resolvedTurnId ?? item.turnId;
          break;
        }
      }
    }
  }

  return {
    resolvedVirtualIndex,
    resolvedTurnId,
    resolvedTurnIndex,
    focusItemId: itemId,
    expandExploreGroupId,
    preferTurnNavigation: source === 'btw-back',
  };
}
