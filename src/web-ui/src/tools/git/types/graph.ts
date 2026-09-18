import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git graph view types
 */

export type { GitGraph, GitGraphNode, GitGraphRef } from '@/infrastructure/api/service-api/GitAPI';

export interface GitGraphViewConfig {
  laneWidth?: number;
  rowHeight?: number;
  nodeSize?: number;
  lineWidth?: number;
  colors?: string[];
  showAvatar?: boolean;
  showRelativeTime?: boolean;
}

export interface GitGraphSearchFilter {
  query: string;
  matchedHashes: Set<string>;
  currentIndex: number;
  totalMatches: number;
}

export interface GitGraphInteractionState {
  selectedHash?: string;
  hoveredHash?: string;
  contextMenu?: {
    hash: string;
    x: number;
    y: number;
  };
  searchFilter?: GitGraphSearchFilter;
}

export interface GitGraphViewProps {
  repositoryPath: GitWorkspaceScope;
  maxCount?: number;
  config?: GitGraphViewConfig;
  onCommitSelect?: (hash: string) => void;
  onCommitAction?: (action: string, hash: string) => void;
  className?: string;
}

