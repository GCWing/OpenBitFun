import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git state management types
 * 
 * Design principles:
 * - Layered data: L1 basic / L2 status / L3 detailed
 * - Type-safe: complete TypeScript definitions
 * - Backward compatible: compatible with existing repository.ts types
 */

import type { GitFileStatusDetail, GitBranch, GitCommit } from '../types/repository';

export type GitStateLayer = 'basic' | 'status' | 'detailed';

export interface GitState {
  isRepository: boolean;
  /**
   * The repository exists but Git refuses to read it because the directory is
   * owned by another user. Distinct from `error` so surfaces can offer the
   * trust action instead of rendering a localized message.
   */
  repositoryTrustRequired: boolean;
  currentBranch: string | null;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  
  staged: GitFileStatusDetail[];
  unstaged: GitFileStatusDetail[];
  untracked: string[];
  conflicts: string[];
  
  branches?: GitBranch[];
  commits?: GitCommit[];
  
  lastRefreshTime: {
    basic: number;
    status: number;
    detailed: number;
  };
  
  isRefreshing: boolean;
  refreshingLayers: Set<GitStateLayer>;
  error: string | null;
}

export function createInitialGitState(): GitState {
  return {
    isRepository: false,
    repositoryTrustRequired: false,
    currentBranch: null,
    ahead: 0,
    behind: 0,
    hasChanges: false,
    
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    
    branches: undefined,
    commits: undefined,
    
    lastRefreshTime: {
      basic: 0,
      status: 0,
      detailed: 0,
    },
    isRefreshing: false,
    refreshingLayers: new Set(),
    error: null,
  };
}

export interface RefreshOptions {
  force?: boolean;
  layers?: GitStateLayer[];
  silent?: boolean;
  reason?: RefreshReason;
  source?: string;
}

export type RefreshReason =
  | 'mount'
  | 'visibility'
  | 'manual'
  | 'operation'
  | 'file-change'
  | 'window-focus'
  | 'interval';

export interface CacheConfig {
  basic: number;
  status: number;
  detailed: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  basic: Infinity,
  status: 30 * 1000,
  detailed: 60 * 1000,
};

export type GitStateSubscriber = (
  state: GitState,
  prevState: GitState | null,
  changedLayers: GitStateLayer[]
) => void;

export interface SubscribeOptions {
  layers?: GitStateLayer[];
  immediate?: boolean;
}


/** Options for the `useGitState` hook. */
export interface UseGitStateOptions {
  /** Repository path */
  repositoryPath: GitWorkspaceScope;
  
  /** Whether the component is active/visible */
  isActive?: boolean;

  /**
   * Whether this consumer should participate in global window-focus refresh.
   * Disable for passive consumers such as sidebar branch badges.
   */
  participateInWindowFocusRefresh?: boolean;
  
  /** Optional selector to reduce re-renders */
  selector?: <T>(state: GitState) => T;
  
  /** Refresh on mount */
  refreshOnMount?: boolean;
  
  /** Refresh when activated */
  refreshOnActive?: boolean;

  /** Debug/performance source label for automatic refreshes. */
  debugSource?: string;

  /**
   * Additional automatic refresh source labels that may be cancelled while this
   * consumer temporarily suppresses mount refreshes.
   */
  cancelPendingRefreshSources?: readonly string[];
  
  /** Layers to subscribe to */
  layers?: GitStateLayer[];
}

/** Return value of the `useGitState` hook. */
export interface UseGitStateReturn {

  state: GitState | null;
  isLoading: boolean;
  error: string | null;
  

  refresh: (options?: RefreshOptions) => Promise<void>;
  refreshBasic: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshDetailed: () => Promise<void>;
  
  isRepository: boolean;
  /** Git refuses this repository on ownership grounds; offer the trust action. */
  repositoryTrustRequired: boolean;
  currentBranch: string | null;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  
  staged: GitFileStatusDetail[];
  unstaged: GitFileStatusDetail[];
  untracked: string[];
  conflicts: string[];
  
  branches: GitBranch[] | undefined;
  commits: GitCommit[] | undefined;
}

export interface GitStateChangedEventData {
  repositoryPath: GitWorkspaceScope;
  state: GitState;
  changedLayers: GitStateLayer[];
  reason: RefreshReason;
  timestamp: number;
}

export type GitStateManagerEventType =
  | 'state:changed'
  | 'state:refreshing'
  | 'state:refreshed'
  | 'state:error';

export type PartialGitState = Partial<Omit<GitState, 'lastRefreshTime' | 'refreshingLayers'>>;

export interface StateComparison {
  hasChanges: boolean;
  changedLayers: GitStateLayer[];
  changedFields: (keyof GitState)[];
}

export function compareStates(
  prevState: GitState | null,
  newState: GitState
): StateComparison {
  if (!prevState) {
    return {
      hasChanges: true,
      changedLayers: ['basic', 'status', 'detailed'],
      changedFields: Object.keys(newState) as (keyof GitState)[],
    };
  }

  const changedLayers: GitStateLayer[] = [];
  const changedFields: (keyof GitState)[] = [];

  const basicFields: (keyof GitState)[] = [
    'isRepository', 'repositoryTrustRequired', 'currentBranch', 'ahead', 'behind', 'hasChanges'
  ];
  for (const field of basicFields) {
    if (prevState[field] !== newState[field]) {
      changedFields.push(field);
      if (!changedLayers.includes('basic')) {
        changedLayers.push('basic');
      }
    }
  }


  const statusFields: (keyof GitState)[] = ['staged', 'unstaged', 'untracked', 'conflicts'];
  for (const field of statusFields) {
    const prevVal = JSON.stringify(prevState[field]);
    const newVal = JSON.stringify(newState[field]);
    if (prevVal !== newVal) {
      changedFields.push(field);
      if (!changedLayers.includes('status')) {
        changedLayers.push('status');
      }
    }
  }


  const detailedFields: (keyof GitState)[] = ['branches', 'commits'];
  for (const field of detailedFields) {
    const prevVal = JSON.stringify(prevState[field]);
    const newVal = JSON.stringify(newState[field]);
    if (prevVal !== newVal) {
      changedFields.push(field);
      if (!changedLayers.includes('detailed')) {
        changedLayers.push('detailed');
      }
    }
  }

  return {
    hasChanges: changedLayers.length > 0,
    changedLayers,
    changedFields,
  };
}
