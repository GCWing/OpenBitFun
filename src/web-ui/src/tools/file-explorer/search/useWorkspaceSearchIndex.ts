import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceAPI } from '@/infrastructure/api';
import type {
  WorkspaceSearchIndexStatus,
  WorkspaceSearchIndexTaskHandle,
} from '@/infrastructure/api/service-api/tauri-commands';
import { createLogger } from '@/shared/utils/logger';
import {
  isPeerDeviceModeActive,
  PEER_MODE_SEARCH_ACTIVE_POLL_MS,
  PEER_MODE_SEARCH_IDLE_POLL_MS,
} from '@/infrastructure/peer-device/peerModeFlag';
import { WORKSPACE_SEARCH_AVAILABLE } from '@/infrastructure/config/workspaceSearchAvailability';

const log = createLogger('useWorkspaceSearchIndex');
const ACTIVE_TASK_POLL_MS = 1000;
const IDLE_STATUS_POLL_MS = 5000;

// Kept in sync with `NON_GIT_WORKSPACE_MESSAGE` in `src/apps/desktop/src/api/search_api.rs`.
const NON_GIT_WORKSPACE_MESSAGE = 'Workspace search requires a Git worktree with a HEAD commit';

export type WorkspaceSearchUnsupportedReason = 'non_git' | 'other';

// A workspace that flashgrep cannot index is not an error state: content search silently falls
// back, so the caller should stop polling and render a neutral indicator rather than a red one.
function workspaceSearchUnsupportedReason(
  message: string
): WorkspaceSearchUnsupportedReason | null {
  if (message.includes(NON_GIT_WORKSPACE_MESSAGE)) {
    return 'non_git';
  }
  if (
    message.includes('Flashgrep is not supported for remote workspaces')
    || message.includes('Workspace search is disabled')
    || message.includes('Workspace search daemon is unavailable')
    || message.includes('Remote workspace search status is not managed')
  ) {
    return 'other';
  }
  return null;
}

export interface UseWorkspaceSearchIndexOptions {
  workspaceId?: string;
  enabled?: boolean;
  isRemote?: boolean;
}

export interface UseWorkspaceSearchIndexResult {
  indexStatus: WorkspaceSearchIndexStatus | null;
  loading: boolean;
  refreshing: boolean;
  actionRunning: boolean;
  error: string | null;
  supported: boolean;
  hasActiveTask: boolean;
  unsupportedReason: WorkspaceSearchUnsupportedReason | null;
  refreshStatus: (silent?: boolean) => Promise<WorkspaceSearchIndexStatus | null>;
  buildIndex: () => Promise<WorkspaceSearchIndexTaskHandle | null>;
  rebuildIndex: () => Promise<WorkspaceSearchIndexTaskHandle | null>;
}

function isTaskActive(status: WorkspaceSearchIndexStatus | null): boolean {
  const state = status?.activeTask?.state;
  return state === 'queued' || state === 'running';
}

export function useWorkspaceSearchIndex(
  options: UseWorkspaceSearchIndexOptions = {}
): UseWorkspaceSearchIndexResult {
  const { workspaceId, enabled: requestedEnabled = true, isRemote = false } = options;
  const enabled = WORKSPACE_SEARCH_AVAILABLE && !isRemote && requestedEnabled;

  const [indexStatus, setIndexStatus] = useState<WorkspaceSearchIndexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupportedReason, setUnsupportedReason] =
    useState<WorkspaceSearchUnsupportedReason | null>(null);
  const supported = Boolean(workspaceId && enabled && unsupportedReason === null);

  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshStatus = useCallback(
    async (silent: boolean = false): Promise<WorkspaceSearchIndexStatus | null> => {
      if (!workspaceId || !enabled) {
        if (mountedRef.current) {
          setIndexStatus(null);
          setError(null);
        }
        return null;
      }

      if (mountedRef.current) {
        if (silent) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
      }

      try {
        const status = await workspaceAPI.getSearchRepoStatus(workspaceId);
        if (!mountedRef.current) {
          return status;
        }
        setIndexStatus(status);
        setError(null);
        return status;
      } catch (err) {
        if (!mountedRef.current) {
          return null;
        }
        const message = err instanceof Error ? err.message : 'Failed to load search index status';
        const reason = workspaceSearchUnsupportedReason(message);
        if (reason) {
          setUnsupportedReason(reason);
          setIndexStatus(null);
          setError(null);
          return null;
        }
        log.warn('Failed to refresh workspace search index status', {
          workspaceId,
          error: err,
        });
        setError(message);
        return null;
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [enabled, workspaceId]
  );

  const runIndexAction = useCallback(
    async (
      action: 'build' | 'rebuild'
    ): Promise<WorkspaceSearchIndexTaskHandle | null> => {
      if (!workspaceId || !enabled) {
        return null;
      }

      setActionRunning(true);
      try {
        const result =
          action === 'build'
            ? await workspaceAPI.buildSearchIndex(workspaceId)
            : await workspaceAPI.rebuildSearchIndex(workspaceId);
        if (mountedRef.current) {
          // The task handle carries no auto-index decision, but a manual build does not change
          // one either, so the last known decision is kept until the next status refresh.
          setIndexStatus((previous) => ({
            repoStatus: result.repoStatus,
            activeTask: result.task,
            autoIndex: previous?.autoIndex ?? null,
          }));
          setError(null);
        }
        return result;
      } catch (err) {
        if (mountedRef.current) {
          const message = err instanceof Error ? err.message : `Failed to ${action} search index`;
          const reason = workspaceSearchUnsupportedReason(message);
          if (reason) {
            setUnsupportedReason(reason);
            setIndexStatus(null);
            setError(null);
          } else {
            setError(message);
          }
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setActionRunning(false);
        }
      }
    },
    [enabled, workspaceId]
  );

  const buildIndex = useCallback(async () => runIndexAction('build'), [runIndexAction]);
  const rebuildIndex = useCallback(async () => runIndexAction('rebuild'), [runIndexAction]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  useEffect(() => {
    setUnsupportedReason(null);
  }, [enabled, workspaceId]);

  useEffect(() => {
    clearPollTimer();

    if (!supported) {
      setIndexStatus(null);
      setLoading(false);
      setRefreshing(false);
      setActionRunning(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const scheduleNext = (status: WorkspaceSearchIndexStatus | null) => {
      if (cancelled || !mountedRef.current) {
        return;
      }
      const delay = isTaskActive(status)
        ? (isPeerDeviceModeActive() ? PEER_MODE_SEARCH_ACTIVE_POLL_MS : ACTIVE_TASK_POLL_MS)
        : (isPeerDeviceModeActive() ? PEER_MODE_SEARCH_IDLE_POLL_MS : IDLE_STATUS_POLL_MS);
      pollTimerRef.current = setTimeout(() => {
        void refreshStatus(true).then((nextStatus) => {
          scheduleNext(nextStatus);
        });
      }, delay);
    };

    void refreshStatus(false).then((status) => {
      if (!cancelled) {
        scheduleNext(status);
      }
    });

    return () => {
      cancelled = true;
      clearPollTimer();
    };
  }, [clearPollTimer, refreshStatus, supported, workspaceId]);

  return useMemo(
    () => ({
      indexStatus,
      loading,
      refreshing,
      actionRunning,
      error,
      supported,
      unsupportedReason,
      hasActiveTask: isTaskActive(indexStatus),
      refreshStatus,
      buildIndex,
      rebuildIndex,
    }),
    [
      actionRunning,
      buildIndex,
      error,
      indexStatus,
      loading,
      rebuildIndex,
      refreshStatus,
      refreshing,
      supported,
      unsupportedReason,
    ]
  );
}

export default useWorkspaceSearchIndex;
