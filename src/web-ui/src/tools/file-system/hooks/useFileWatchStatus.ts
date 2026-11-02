import { useCallback, useEffect, useState } from 'react';
import { api, workspaceAPI } from '@/infrastructure/api';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { FileWatchStatus } from '@/infrastructure/api/service-api/tauri-commands';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useFileWatchStatus');

/** Event emitted by the file watch service whenever coverage changes. */
export const FILE_WATCH_STATUS_CHANGED_EVENT = 'file-watch-status-changed';

/**
 * Local bus event fired once a backend watch registration attempt settles.
 *
 * A registration can fail before the service's event subscriber exists (the
 * emitter is wired asynchronously during startup), and an event emitted then is
 * lost. Re-reading on settle makes the notice independent of that ordering.
 */
export const FILE_WATCH_SETTLED_EVENT = 'file-watch:settled';

export interface FileWatchStatusState {
  /** `null` until the first read, or while tracking is disabled. */
  status: FileWatchStatus | null;
  retrying: boolean;
  retry: () => Promise<void>;
}

/**
 * Tracks whether the host's file watcher still covers the workspace.
 *
 * Watching is a host-side resource, so a remote workspace has no local watcher
 * to report on and callers must disable tracking instead of showing stale state.
 */
export function useFileWatchStatus(enabled: boolean): FileWatchStatusState {
  const [status, setStatus] = useState<FileWatchStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let active = true;
    const readStatus = () => {
      void workspaceAPI
        .getFileWatchStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((error) => {
          // The notice explains a broken watcher; a failed read must not invent
          // one. Keep the previous state and leave the diagnosis to the log.
          log.warn('Failed to read file watch status', { error: String(error) });
        });
    };

    const unlisten = api.listen<FileWatchStatus>(FILE_WATCH_STATUS_CHANGED_EVENT, (next) => {
      if (active) setStatus(next);
    });
    const offSettled = globalEventBus.on(FILE_WATCH_SETTLED_EVENT, () => {
      if (active) readStatus();
    });

    readStatus();

    return () => {
      active = false;
      unlisten();
      offSettled();
    };
  }, [enabled]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await workspaceAPI.retryFileWatch();
      setStatus(await workspaceAPI.getFileWatchStatus());
    } catch (error) {
      log.warn('Failed to re-register file watch', { error: String(error) });
    } finally {
      setRetrying(false);
    }
  }, []);

  return { status, retrying, retry };
}
