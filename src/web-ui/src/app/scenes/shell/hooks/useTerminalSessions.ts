import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getTerminalService } from '@/tools/terminal/services/TerminalService';
import type { SessionResponse } from '@/tools/terminal/types/session';
import { createManualTerminalSession } from '@/shared/services/createManualTerminalSession';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  terminalBelongsToWorkspace, type TerminalWorkspaceScope,
} from '@/tools/terminal/services/terminalWorkspaceScope';
import { isSessionRunning, type ShellEntry } from './shellEntryTypes';

interface UseTerminalSessionsOptions {
  workspaceId?: string;
  workspacePath?: string;
  isRemote: boolean;
  currentConnectionId: string | null;
  scope: SurfaceScope;
  savedSessionIds: Set<string>;
}
interface SessionSnapshot {
  key: string;
  sessions: SessionResponse[];
  loading: boolean;
  error: string | null;
}
// Read projections survive panel navigation; they never own or stop a PTY.
const snapshots = new Map<string, SessionResponse[]>();

export function useTerminalSessions(options: UseTerminalSessionsOptions) {
  const { workspaceId, workspacePath, isRemote, currentConnectionId, scope, savedSessionIds } = options;
  const key = scope.key('workspace-terminals', workspaceId);
  const activation = useMemo(() => ({ key, scope }), [key, scope]);
  const currentActivation = useRef<typeof activation | null>(activation);
  currentActivation.current = activation;
  useEffect(() => {
    currentActivation.current = activation;
    return () => { currentActivation.current = null; };
  }, [activation]);
  const requestVersion = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => ({
    key, sessions: snapshots.get(key) ?? [], loading: true, error: null,
  }));
  const sessions = useMemo(
    () => snapshot.key === key ? snapshot.sessions : snapshots.get(key) ?? [],
    [key, snapshot],
  );
  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
  const target = useMemo<TerminalWorkspaceScope>(() => ({
    workspaceId: workspaceId ?? '',
    rootPath: workspacePath ?? '', isRemote, connectionId: currentConnectionId,
  }), [workspaceId, workspacePath, isRemote, currentConnectionId]);
  const assertCurrent = useCallback(() => {
    scope.assertCurrent('workspace terminal action');
    if (!workspaceId) throw new Error('Workspace ID is unavailable');
    if (currentActivation.current !== activation) throw new Error('Workspace changed during terminal action');
    if (isRemote && !currentConnectionId) throw new Error('Remote workspace connection is unavailable');
  }, [scope, activation, isRemote, currentConnectionId, workspaceId]);

  const refreshSessions = useCallback(async () => {
    if (!workspaceId || !scope.isCurrent() || currentActivation.current !== activation) return;
    const version = ++requestVersion.current;
    setSnapshot(previous => ({
      key, sessions: previous.key === key ? previous.sessions : snapshots.get(key) ?? [],
      loading: true, error: previous.key === key ? previous.error : null,
    }));
    try {
      assertCurrent();
      const service = getTerminalService();
      await service.connect();
      assertCurrent();
      const allSessions = await service.listSessions();
      if (!scope.isCurrent() || currentActivation.current !== activation || version !== requestVersion.current) return;
      // A PTY is claimed by workspace ID. Legacy PTYs without an ID are only
      // claimed through this workspace's own saved profiles, never by matching
      // the connection or cwd.
      const filtered = allSessions.filter(session =>
        (!session.workspaceId && savedSessionIds.has(session.id))
        || terminalBelongsToWorkspace(session, target),
      );
      snapshots.set(key, filtered);
      setSnapshot({ key, sessions: filtered, loading: false, error: null });
    } catch (error) {
      if (!scope.isCurrent() || currentActivation.current !== activation || version !== requestVersion.current) return;
      setSnapshot(previous => ({
        key, sessions: previous.key === key ? previous.sessions : snapshots.get(key) ?? [],
        loading: false, error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [activation, assertCurrent, key, savedSessionIds, scope, target, workspaceId]);

  useEffect(() => {
    const service = getTerminalService();
    void refreshSessions();
    const unsubscribe = service.onEvent(event => {
      if (event.type === 'ready' || event.type === 'exit' || event.type === 'error') {
        void refreshSessions();
      } else if (event.type === 'cwd' || event.type === 'title') {
        if (!scope.isCurrent() || currentActivation.current !== activation) return;
        setSnapshot(previous => {
          if (previous.key !== key) return previous;
          const next = previous.sessions.map(session => session.id !== event.sessionId ? session : {
            ...session, ...(event.type === 'cwd' ? { cwd: event.cwd } : { name: event.title }),
          });
          snapshots.set(key, next);
          return { ...previous, sessions: next };
        });
      }
    });
    window.addEventListener('focus', refreshSessions);
    return () => {
      requestVersion.current += 1;
      unsubscribe();
      window.removeEventListener('focus', refreshSessions);
    };
  }, [activation, key, refreshSessions, scope]);

  const closeSessionIfPresent = useCallback(async (sessionId: string) => {
    assertCurrent();
    if (!sessionMap.has(sessionId)) return;
    await getTerminalService().closeSession(sessionId);
    assertCurrent();
    window.dispatchEvent(new CustomEvent('terminal-session-destroyed', { detail: { sessionId } }));
    await refreshSessions();
  }, [assertCurrent, refreshSessions, sessionMap]);

  const startEntrySession = useCallback(async (entry: ShellEntry) => {
    assertCurrent();
    const current = sessionMap.get(entry.sessionId);
    if (current && isSessionRunning(current)) return { session: current, created: false };
    if (current) {
      await getTerminalService().closeSession(entry.sessionId);
      assertCurrent();
    }
    const session = await createManualTerminalSession({
      workspaceId: workspaceId!,
      workspacePath: entry.workingDirectory ?? entry.cwd ?? workspacePath,
      shellType: entry.shellType,
      sessionId: entry.sessionId, name: entry.name,
    });
    assertCurrent();
    await refreshSessions();
    assertCurrent();
    return { session, created: true };
  }, [assertCurrent, refreshSessions, sessionMap, workspacePath, workspaceId]);

  const createManualSession = useCallback(async (shellType?: string, directory?: string, shellId?: string) => {
    assertCurrent();
    const session = await createManualTerminalSession({
      workspaceId: workspaceId!,
      workspacePath: directory ?? workspacePath, shellType, shellId,
    });
    assertCurrent();
    await refreshSessions();
    assertCurrent();
    return session;
  }, [assertCurrent, refreshSessions, workspacePath, workspaceId]);
  const stopEntrySession = useCallback(async (entry: ShellEntry) => {
    if (entry.isRunning) await closeSessionIfPresent(entry.sessionId);
  }, [closeSessionIfPresent]);
  const renameSessionLocally = useCallback((sessionId: string, newName: string) => {
    assertCurrent();
    setSnapshot(previous => {
      if (previous.key !== key) return previous;
      const next = previous.sessions.map(session => session.id === sessionId ? { ...session, name: newName } : session);
      snapshots.set(key, next);
      return { ...previous, sessions: next };
    });
    window.dispatchEvent(new CustomEvent('terminal-session-renamed', { detail: { sessionId, newName, surfaceId: getActiveSurfaceId() } }));
  }, [assertCurrent, key]);
  const hasSession = useCallback((sessionId: string) => sessionMap.has(sessionId), [sessionMap]);

  return {
    assertCurrent,
    sessions, sessionMap, loading: snapshot.key !== key || snapshot.loading,
    error: snapshot.key === key ? snapshot.error : null,
    refreshSessions, startEntrySession, createManualSession, stopEntrySession, closeSessionIfPresent,
    renameSessionLocally, hasSession,
  };
}
