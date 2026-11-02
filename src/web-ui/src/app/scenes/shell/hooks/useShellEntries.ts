import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useSessionTerminalDirectory } from '@/app/hooks/useSessionTerminalDirectory';
import { openShellSessionTarget } from '@/shared/services/openShellSessionTarget';
import {
  AGENT_SOURCE,
  compareShellEntries,
  createManualProfileEntry,
  createSessionEntry,
  MANUAL_SOURCE,
  type SaveShellEntryInput,
  type ShellEntry,
} from './shellEntryTypes';
import { useManualTerminalProfiles } from './useManualTerminalProfiles';
import { getTerminalService } from '@/tools/terminal/services/TerminalService';
import { useTerminalSessions } from './useTerminalSessions';
import type { WorkspaceInfo } from '@/shared/types';

interface EditingTerminalState {
  entry: ShellEntry;
  key: string | undefined;
}

export interface UseShellEntriesReturn {
  entries: ShellEntry[];
  loading: boolean;
  error: string | null;
  editModalOpen: boolean;
  editingTerminal: EditingTerminalState | null;
  closeEditModal: () => void;
  refresh: () => Promise<void>;
  createManualTerminal: (shellType?: string, directory?: string, shellId?: string) => Promise<void>;
  openEntry: (entry: ShellEntry) => Promise<void>;
  startEntry: (entry: ShellEntry) => Promise<string>;
  stopEntry: (entry: ShellEntry) => Promise<void>;
  deleteEntry: (entry: ShellEntry) => Promise<void>;
  openEditModal: (entry: ShellEntry) => void;
  saveEdit: (input: SaveShellEntryInput) => void;
}

export function useShellEntries(targetWorkspace?: WorkspaceInfo | null): UseShellEntriesReturn {
  const { activeWorkspace } = useWorkspaceContext();
  const workspace = targetWorkspace === undefined ? activeWorkspace : targetWorkspace;
  const workspacePath = workspace?.rootPath ?? '';
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const isRemote = workspace?.workspaceKind === 'remote';
  const currentConnectionId = isRemote ? workspace?.connectionId ?? null : null;
  const workspaceId = workspace?.id;
  const profileWorkspace = useMemo(
    () => (workspaceId ? { surfaceId: scope.surfaceId, workspaceId } : undefined),
    [scope.surfaceId, workspaceId],
  );
  const profileKey = scope.key('terminal-profiles', workspace?.id);
  // A terminal opened here serves the session that owns this workspace, so it
  // must start where that session executes: a worktree session's cwd is the
  // worktree, not the project root.
  const sessionDirectory = useSessionTerminalDirectory(workspaceId);

  const [editingState, setEditingTerminal] = useState<EditingTerminalState | null>(null);
  const editingTerminal = editingState?.key === profileKey ? editingState : null;
  const editModalOpen = editingTerminal !== null;
  useEffect(() => { setEditingTerminal(null); }, [profileKey, scope]);

  const {
    profiles,
    error: profilesError,
    profilesBySessionId,
    refreshProfiles,
    saveProfile,
    removeProfile,
    getProfileById,
    getProfileBySessionId,
  } = useManualTerminalProfiles(profileWorkspace);
  const savedSessionIds = useMemo(() => new Set(profiles.map(profile => profile.sessionId)), [profiles]);
  const {
    assertCurrent,
    loading,
    error,
    sessions,
    sessionMap,
    refreshSessions,
    startEntrySession,
    createManualSession,
    stopEntrySession,
    closeSessionIfPresent,
    renameSessionLocally,
    hasSession,
  } = useTerminalSessions({
    workspaceId: workspace?.id,
    workspacePath,
    defaultDirectory: sessionDirectory,
    isRemote,
    currentConnectionId,
    scope,
    savedSessionIds,
  });

  const manualEntries = useMemo<ShellEntry[]>(() => {
    const profileEntries = profiles.map((profile) =>
      createManualProfileEntry(profile, sessionMap.get(profile.sessionId)),
    );

    const ephemeralEntries = sessions
      .filter((session) => session.source === MANUAL_SOURCE && !profilesBySessionId.has(session.id))
      .map((session) => createSessionEntry(session, 'manual-session'));

    return [...profileEntries, ...ephemeralEntries].sort(compareShellEntries);
  }, [profiles, profilesBySessionId, sessionMap, sessions]);

  const agentEntries = useMemo<ShellEntry[]>(
    () =>
      sessions
        .filter((session) => session.source === AGENT_SOURCE && !profilesBySessionId.has(session.id))
        .map((session) => createSessionEntry(session, 'agent-session'))
        .sort(compareShellEntries),
    [profilesBySessionId, sessions],
  );

  const entries = useMemo<ShellEntry[]>(
    () => [...manualEntries, ...agentEntries].sort(compareShellEntries),
    [agentEntries, manualEntries],
  );

  const refresh = useCallback(async () => {
    await refreshSessions();
    assertCurrent();
    refreshProfiles();
  }, [assertCurrent, refreshProfiles, refreshSessions]);

  const openShellSession = useCallback((sessionId: string, sessionName: string) => {
    assertCurrent();
    openShellSessionTarget({ sessionId, sessionName, scope: {
      surfaceId: scope.surfaceId, workspaceId: workspace?.id,
      workspacePath, remoteConnectionId: currentConnectionId ?? undefined,
    } });
  }, [assertCurrent, scope.surfaceId, workspace?.id, workspacePath, currentConnectionId]);

  const startEntry = useCallback(async (entry: ShellEntry) => {
    const { session, created } = await startEntrySession(entry);
    assertCurrent();
    // SSH and older hosts may allocate a new id despite the requested id.
    // Bind the saved configuration before running a command that can fail.
    if (entry.profileId && session.id !== entry.sessionId) {
      saveProfile({
        id: entry.profileId, sessionId: session.id, name: entry.name,
        workingDirectory: entry.workingDirectory, startupCommand: entry.startupCommand,
        shellType: entry.shellType,
      });
    }
    openShellSession(session.id, entry.name);
    if (created && entry.startupCommand?.trim()) {
      await getTerminalService().sendCommand(session.id, entry.startupCommand);
      assertCurrent();
    }
    return session.id;
  }, [assertCurrent, openShellSession, saveProfile, startEntrySession]);

  const openEntry = useCallback(async (entry: ShellEntry) => {
    assertCurrent();
    if (!entry.isRunning && entry.isPersisted) {
      setEditingTerminal({ entry, key: profileKey });
      return;
    }

    openShellSession(entry.sessionId, entry.name);
  }, [assertCurrent, openShellSession, profileKey]);

  const createManualTerminal = useCallback(async (shellType?: string, directory?: string, shellId?: string) => {
    const session = await createManualSession(shellType, directory, shellId);
    if (session) {
      openShellSession(session.id, session.name);
    }
  }, [createManualSession, openShellSession]);

  const stopEntry = useCallback(async (entry: ShellEntry) => {
    await stopEntrySession(entry);
  }, [stopEntrySession]);

  const deleteEntry = useCallback(async (entry: ShellEntry) => {
    assertCurrent();
    if (entry.profileId) {
      removeProfile(entry.profileId);
      return;
    }

    if (entry.isRunning) throw new Error('Stop the terminal before removing it');
    if (hasSession(entry.sessionId)) {
      await closeSessionIfPresent(entry.sessionId);
    }

    await refreshSessions();
  }, [assertCurrent, closeSessionIfPresent, hasSession, refreshSessions, removeProfile]);

  const openEditModal = useCallback((entry: ShellEntry) => {
    assertCurrent();
    setEditingTerminal({ entry, key: profileKey });
  }, [assertCurrent, profileKey]);

  const closeEditModal = useCallback(() => {
    setEditingTerminal(null);
  }, []);

  const saveEdit = useCallback((input: SaveShellEntryInput) => {
    assertCurrent();
    if (!editingTerminal || !workspacePath) {
      return;
    }

    const entry = editingTerminal.entry;
    const existingProfile = entry.profileId
      ? getProfileById(entry.profileId)
      : getProfileBySessionId(entry.sessionId);

    saveProfile({
      id: existingProfile?.id,
      sessionId: entry.sessionId,
      name: input.name,
      workingDirectory: input.workingDirectory ?? entry.workingDirectory ?? entry.cwd ?? workspacePath,
      startupCommand: input.startupCommand,
      shellType: entry.shellType,
    });

    if (hasSession(entry.sessionId)) {
      renameSessionLocally(entry.sessionId, input.name);
    }

    closeEditModal();
  }, [assertCurrent, closeEditModal, editingTerminal, getProfileById, getProfileBySessionId, hasSession, renameSessionLocally, saveProfile, workspacePath]);

  return {
    entries,
    loading,
    error: error || profilesError,
    editModalOpen,
    editingTerminal,
    closeEditModal,
    refresh,
    createManualTerminal,
    openEntry,
    startEntry,
    stopEntry,
    deleteEntry,
    openEditModal,
    saveEdit,
  };
}
