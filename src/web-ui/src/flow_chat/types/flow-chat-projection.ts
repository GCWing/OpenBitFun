import type { DialogTurn, ModelRound, FlowToolItem, FlowUserSteeringItem, TokenUsage } from './flow-chat';
import type { ExploreGroupData, ModelRoundItemGroup } from '../grouping/types';
import type { TurnCompletionNotice } from '../utils/turnCompletionNotice';

/** Render units preserve existing virtual keys independently of semantic grouping. */
export type VirtualItem =
  | {
      type: 'user-message';
      data: DialogTurn['userMessage'];
      turnId: string;
      absoluteTurnIndex?: number;
      turnStatus?: DialogTurn['status'];
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
