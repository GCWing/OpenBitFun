import { useCallback, useEffect, useRef, useState } from 'react';

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';

export interface SessionModeSelectionTarget {
  draft?: boolean;
  sessionId: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

interface ModeSelectionIntent {
  request: SessionModeSelectionTarget & { modeId: string };
  publish: (modeId: string) => void;
  reportFailure: (error: unknown, modeId: string) => void;
}

interface SessionModeSelectionQueue {
  next?: ModeSelectionIntent;
}

/**
 * Keep passive selector hydration separate from an explicit Runtime rebind.
 * A catalog refresh may change which same-name route is currently offered,
 * but only a user selection may replace a Session's durable route owner.
 */
export function useSessionModeSelection(
  target: SessionModeSelectionTarget | null,
  publishSelection: (modeId: string) => void,
  reportFailure: (error: unknown, modeId: string) => void,
  onSelectionCommitted?: (modeId: string) => void,
): {
  isModeChangePending: boolean;
  publishModeSelection: (modeId: string) => void;
  requestModeChange: (modeId: string) => void;
} {
  const publishRef = useRef(publishSelection);
  const failureRef = useRef(reportFailure);
  const committedRef = useRef(onSelectionCommitted);
  const sessionQueuesRef = useRef(new Map<string, SessionModeSelectionQueue>());
  const mountedRef = useRef(true);
  const [, setQueueRevision] = useState(0);
  publishRef.current = publishSelection;
  failureRef.current = reportFailure;
  committedRef.current = onSelectionCommitted;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const notifyQueueChanged = useCallback(() => {
    if (mountedRef.current) {
      setQueueRevision(revision => revision + 1);
    }
  }, []);

  const sessionId = target?.sessionId;
  const draft = target?.draft;
  const workspacePath = target?.workspacePath;
  const remoteConnectionId = target?.remoteConnectionId;
  const remoteSshHost = target?.remoteSshHost;

  const publishModeSelection = useCallback((modeId: string) => {
    publishRef.current(modeId);
  }, []);

  const requestModeChange = useCallback((modeId: string) => {
    if (!sessionId || draft) {
      publishRef.current(modeId);
      committedRef.current?.(modeId);
      return;
    }
    const intent: ModeSelectionIntent = {
      request: {
        sessionId,
        modeId,
        workspacePath,
        remoteConnectionId,
        remoteSshHost,
      },
      publish: publishRef.current,
      reportFailure: failureRef.current,
    };
    const pendingQueue = sessionQueuesRef.current.get(sessionId);
    if (pendingQueue) {
      pendingQueue.next = intent;
      return;
    }

    const queue: SessionModeSelectionQueue = {};
    sessionQueuesRef.current.set(sessionId, queue);
    notifyQueueChanged();
    const run = async (current: ModeSelectionIntent): Promise<void> => {
      let failed = false;
      let failure: unknown;
      try {
        await agentAPI.updateSessionMode(current.request);
      } catch (error) {
        failed = true;
        failure = error;
      }

      if (!failed) {
        current.publish(current.request.modeId);
        committedRef.current?.(current.request.modeId);
      }

      const next = queue.next;
      queue.next = undefined;
      if (next) {
        await run(next);
        return;
      }

      sessionQueuesRef.current.delete(sessionId);
      notifyQueueChanged();
      if (failed) {
        current.reportFailure(failure, current.request.modeId);
      }
    };
    void run(intent);
  }, [draft, notifyQueueChanged, remoteConnectionId, remoteSshHost, sessionId, workspacePath]);

  return {
    isModeChangePending: Boolean(sessionId && sessionQueuesRef.current.has(sessionId)),
    publishModeSelection,
    requestModeChange,
  };
}
