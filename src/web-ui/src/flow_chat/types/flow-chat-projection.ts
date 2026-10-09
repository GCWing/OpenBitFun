import type { DialogTurn, ModelRound, FlowToolItem, FlowUserSteeringItem, TokenUsage } from './flow-chat';
import type { ExploreGroupData, FlowGroupData, ModelRoundItemGroup } from '../grouping/types';
import type { TurnCompletionNotice } from '../utils/turnCompletionNotice';

/** Render units preserve existing virtual keys independently of semantic grouping. */
export interface TimelineBlock {
  key: string;
  sourceIndex: number;
  kind: 'content' | 'group-header' | 'group-members' | 'round-header' | 'round-footer';
  memberIds: string[];
  group?: FlowGroupData;
  expanded?: boolean;
  first?: boolean;
  last?: boolean;
  memberOrdinal?: number;
  revealThinkingIds?: string[];
  /** Bounded, stable sibling grid; native rows wrap without reparenting cards. */
  layout?: 'agent-cards';
}

export type VirtualItem = VirtualContent & { timeline?: TimelineBlock };

type VirtualContent =
  | {
      type: 'user-message';
      data: DialogTurn['userMessage'];
      turnId: string;
      absoluteTurnIndex?: number;
      turnStatus?: DialogTurn['status'];
      /** Display-only state for a foreground send before its Turn is projected. */
      submissionPhase?: 'forming' | 'failed';
      submissionError?: string;
    }
  | {
      type: 'user-steering-message';
      data: NonNullable<DialogTurn['userMessage']>;
      turnId: string;
      steeringId: string;
      steeringStatus: FlowUserSteeringItem['status'];
    }
  | {
      type: 'model-round';
      data: ModelRound;
      /** Display-only ownership; recorded rounds/items remain unchanged. */
      projectedGroups?: ModelRoundItemGroup[];
      turnId: string;
      isLastRound: boolean;
      isTurnComplete: boolean;
      layoutHints?: {
        expandedThinkingItemIds: string[];
      };
      turnStartedAt?: number;
      turnEndedAt?: number;
      turnDurationMs?: number;
      turnTokenUsage?: TokenUsage;
      canvasArtifactItems?: FlowToolItem[];
    }
  | { type: 'explore-group'; data: ExploreGroupData; turnId: string }
  | { type: 'turn-completion-notice'; data: TurnCompletionNotice; turnId: string }
  | {
      type: 'turn-failure-notice';
      data: {
        error: string;
        errorDetail?: DialogTurn['errorDetail'];
      };
      turnId: string;
    }
  | { type: 'image-analyzing'; turnId: string };
