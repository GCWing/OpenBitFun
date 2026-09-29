import type { ModelRound, FlowToolItem, TokenUsage } from '../../types/flow-chat';
import type { ModelRoundItemGroup } from './modelRoundItemGrouping';

export interface ModelRoundItemProps {
  blockPart?: 'content' | 'header' | 'footer';
  round: ModelRound;
  projectedGroups?: ModelRoundItemGroup[];
  turnId: string;
  isLastRound?: boolean;
  isTurnComplete?: boolean;
  turnStartedAt?: number;
  turnEndedAt?: number;
  turnDurationMs?: number;
  turnTokenUsage?: TokenUsage;
  canvasArtifactItems?: FlowToolItem[];
  expandedThinkingItemIds?: string[];
}

function sameProjectedGroups(left?: ModelRoundItemGroup[], right?: ModelRoundItemGroup[]): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((group, index) => {
    const other = right[index];
    if (group.type === 'critical') return other.type === 'critical' && group.item === other.item;
    if (other.type !== group.type) return false;
    return group.isLast === other.isLast
      && group.items.length === other.items.length
      && group.items.every((item, itemIndex) => item === other.items[itemIndex])
      && group.projection?.groupId === other.projection?.groupId
      && group.projection?.isLastGroupInTurn === other.projection?.isLastGroupInTurn
      && group.projection?.wasCutByCritical === other.projection?.wasCutByCritical
      && group.projection?.sourceGroupIds?.join('\n') === other.projection?.sourceGroupIds?.join('\n');
  });
}

export function areModelRoundItemPropsEqual(prev: ModelRoundItemProps, next: ModelRoundItemProps): boolean {
  // Streaming content accumulates, so always re-render.
  if (next.round.isStreaming || prev.round.isStreaming) {
    return false;
  }

  // In complete state, compare items array reference to detect tool state changes.
  return (
    prev.blockPart === next.blockPart &&
    prev.round.id === next.round.id &&
    prev.round.renderHints?.continuedAfterInterruption === next.round.renderHints?.continuedAfterInterruption &&
    prev.round.renderHints?.disableExploreGrouping === next.round.renderHints?.disableExploreGrouping &&
    prev.round.items === next.round.items &&
    sameProjectedGroups(prev.projectedGroups, next.projectedGroups) &&
    prev.round.attempts === next.round.attempts &&
    prev.round.attemptDiagnostics === next.round.attemptDiagnostics &&
    prev.round.historyRounds === next.round.historyRounds &&
    prev.isLastRound === next.isLastRound &&
    prev.isTurnComplete === next.isTurnComplete &&
    prev.expandedThinkingItemIds === next.expandedThinkingItemIds &&
    prev.turnStartedAt === next.turnStartedAt &&
    prev.turnEndedAt === next.turnEndedAt &&
    prev.turnDurationMs === next.turnDurationMs &&
    prev.turnTokenUsage === next.turnTokenUsage &&
    prev.canvasArtifactItems === next.canvasArtifactItems
  );
}
