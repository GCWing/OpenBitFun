import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Unified Git state consumer hook
 * 
 * Replaces scattered useGitRepository + useGitStatus
 * 
 * Features:
 * - Auto subscribe/unsubscribe GitStateManager
 * - Visibility-aware (with isActive prop)
 * - Selective subscription (only subscribe to needed layers)
 * - Optimized re-renders (using selector)
 * 
 * @example
 * ```tsx
 * const { currentBranch, hasChanges, refresh } = useGitState({
 *   repositoryPath: workspacePath,
 *   isActive: true,
 * });
 * 
 * const { currentBranch, isRepository } = useGitState({
 *   repositoryPath: workspacePath,
 *   layers: ['basic'],
 * });
 * 
 * const branchName = useGitState({
 *   repositoryPath: workspacePath,
 *   selector: (state) => state.currentBranch,
 * });
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { gitStateManager } from '../state/GitStateManager';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import {
  GitState,
  UseGitStateOptions,
  UseGitStateReturn,
  RefreshOptions,
} from '../state/types';
import type { GitBranch, GitCommit } from '../types/repository';
import { useStableGitWorkspaceScope } from './useStableGitWorkspaceScope';

const DEFAULT_CANCEL_PENDING_REFRESH_SOURCES: readonly string[] = [];

export type GitBasicInfoOptions = Pick<
  UseGitStateOptions,
  | 'isActive'
  | 'participateInWindowFocusRefresh'
  | 'refreshOnMount'
  | 'refreshOnActive'
  | 'debugSource'
  | 'cancelPendingRefreshSources'
>;

export function useGitState(options: UseGitStateOptions): UseGitStateReturn {
  const {
    repositoryPath,
    isActive = true,
    participateInWindowFocusRefresh = true,
    selector,
    refreshOnMount = true,
    refreshOnActive = true,
    debugSource = 'use_git_state',
    cancelPendingRefreshSources = DEFAULT_CANCEL_PENDING_REFRESH_SOURCES,
    layers,
  } = options;

  const normalizedPath = useStableGitWorkspaceScope(repositoryPath);

  const [state, setState] = useState<GitState | null>(() =>
    normalizedPath.workspaceId ? gitStateManager.getState(normalizedPath) : null
  );

  const prevActiveRef = useRef(isActive);
  const mountedRef = useRef(true);
  const selectorRef = useRef(selector);
  const layersRef = useRef(layers);
  const suppressedMountRefreshRef = useRef(false);

  useEffect(() => {
    selectorRef.current = selector;
  }, [selector]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    if (!normalizedPath.workspaceId) return;

    mountedRef.current = true;

    const unsubscribe = gitStateManager.subscribe(
      normalizedPath,
      (newState, _prevState, _changedLayers) => {
        if (!mountedRef.current) return;
        if (selectorRef.current) {
          const selectedValue = selectorRef.current(newState);
          setState((prev) => {
            const prevSelected = prev ? selectorRef.current!(prev) : null;
            if (shallowEqual(selectedValue, prevSelected)) {
              return prev;
            }
            return newState;
          });
        } else {
          setState(newState);
        }
      },
      {
        layers: layersRef.current,
        immediate: true,
      }
    );

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [normalizedPath]);

  const isFirstMountRef = useRef(true);

  useEffect(() => {
    if (!normalizedPath.workspaceId || !isActive || !participateInWindowFocusRefresh) {
      return;
    }

    return gitStateManager.registerWindowFocusRefresh(normalizedPath);
  }, [isActive, normalizedPath, participateInWindowFocusRefresh]);

  useEffect(() => {
    if (!normalizedPath.workspaceId || !isActive) {
      return;
    }

    if (!refreshOnMount) {
      const layersToRefresh = layersRef.current || ['basic', 'status'];
      const sourcesToCancel = Array.from(new Set([
        debugSource,
        ...cancelPendingRefreshSources,
      ].filter(Boolean)));
      const cancelAutomaticRefresh = (reason: 'mount' | 'visibility') => {
        for (const source of sourcesToCancel) {
          gitStateManager.cancelPendingRefresh(normalizedPath, {
            layers: layersToRefresh,
            reason,
            source,
          });
        }
      };

      cancelAutomaticRefresh('mount');
      cancelAutomaticRefresh('visibility');
      suppressedMountRefreshRef.current = true;
      return;
    }

    if (!suppressedMountRefreshRef.current) {
      return;
    }

    suppressedMountRefreshRef.current = false;
    gitStateManager.refresh(normalizedPath, {
      layers: layersRef.current || ['basic', 'status'],
      reason: 'visibility',
      source: debugSource,
    });
  }, [
    cancelPendingRefreshSources,
    debugSource,
    isActive,
    normalizedPath,
    refreshOnMount,
  ]);

  useEffect(() => {
    if (!normalizedPath.workspaceId) return;

    const isFirstMount = isFirstMountRef.current;
    isFirstMountRef.current = false;

    const shouldRefresh =
      isActive && (
        (isFirstMount && refreshOnMount) ||
        (!isFirstMount && !prevActiveRef.current && refreshOnActive)
      );

    if (shouldRefresh) {
      sendDebugProbe('useGitState.ts:visibilityEffect', 'Git refresh requested', {
        repositoryPath: normalizedPath,
        isActive,
        reason: isFirstMount ? 'mount' : 'visibility',
        source: debugSource,
        layers: layersRef.current || ['basic', 'status'],
      });
      gitStateManager.refresh(normalizedPath, {
        layers: layersRef.current || ['basic', 'status'],
        reason: isFirstMount ? 'mount' : 'visibility',
        source: debugSource,
      });
    }

    prevActiveRef.current = isActive;
  }, [debugSource, isActive, normalizedPath, refreshOnMount, refreshOnActive]);

  const refresh = useCallback(
    async (options?: RefreshOptions): Promise<void> => {
      if (!normalizedPath.workspaceId) return;
      return gitStateManager.refresh(normalizedPath, {
        ...options,
        layers: options?.layers || layersRef.current || ['basic', 'status'],
      });
    },
    [normalizedPath]
  );

  const refreshBasic = useCallback(async (): Promise<void> => {
    return refresh({ layers: ['basic'] });
  }, [refresh]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    return refresh({ layers: ['basic', 'status'] });
  }, [refresh]);

  const refreshDetailed = useCallback(async (): Promise<void> => {
    return refresh({ layers: ['detailed'], force: true });
  }, [refresh]);

  return {
    state,
    isLoading: state?.isRefreshing ?? false,
    error: state?.error ?? null,

    refresh,
    refreshBasic,
    refreshStatus,
    refreshDetailed,

    isRepository: state?.isRepository ?? false,
    repositoryTrustRequired: state?.repositoryTrustRequired ?? false,
    currentBranch: state?.currentBranch ?? null,
    ahead: state?.ahead ?? 0,
    behind: state?.behind ?? 0,
    hasChanges: state?.hasChanges ?? false,
    staged: state?.staged ?? [],
    unstaged: state?.unstaged ?? [],
    untracked: state?.untracked ?? [],
    conflicts: state?.conflicts ?? [],
    branches: state?.branches,
    commits: state?.commits,
  };
}

/**
 * Optimized hook for basic info only
 * Suitable for scenarios like BottomBar that only need branch name
 */
export function useGitBasicInfo(
  repositoryPath: GitWorkspaceScope,
  options: GitBasicInfoOptions = {}
) {
  return useGitState({
    repositoryPath,
    isActive: options.isActive ?? true,
    participateInWindowFocusRefresh: options.participateInWindowFocusRefresh ?? false,
    layers: ['basic'],
    refreshOnMount: options.refreshOnMount ?? true,
    refreshOnActive: options.refreshOnActive ?? false,
    debugSource: options.debugSource ?? 'use_git_basic_info',
    cancelPendingRefreshSources: options.cancelPendingRefreshSources,
  });
}

/**
 * Hook for file status only
 */
export function useGitFileStatus(
  repositoryPath: GitWorkspaceScope,
  options: { isActive?: boolean } = {}
) {
  return useGitState({
    repositoryPath,
    isActive: options.isActive ?? true,
    layers: ['basic', 'status'],
    refreshOnMount: true,
    refreshOnActive: true,
    debugSource: 'use_git_file_status',
  });
}

/** Hook for branch list. */
export function useGitBranches(repositoryPath: GitWorkspaceScope): {
  branches: GitBranch[] | undefined;
  currentBranch: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const { branches, currentBranch, isLoading, refreshDetailed } = useGitState({
    repositoryPath,
    layers: ['basic', 'detailed'],
    refreshOnMount: true,
    debugSource: 'use_git_branches',
  });

  return {
    branches,
    currentBranch,
    isLoading,
    refresh: refreshDetailed,
  };
}

/**
 * Hook for commit history
 */
export function useGitCommits(repositoryPath: GitWorkspaceScope): {
  commits: GitCommit[] | undefined;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const { commits, isLoading, refreshDetailed } = useGitState({
    repositoryPath,
    layers: ['detailed'],
    refreshOnMount: true,
    debugSource: 'use_git_commits',
  });

  return {
    commits,
    isLoading,
    refresh: refreshDetailed,
  };
}

function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}
