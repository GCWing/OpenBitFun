import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteManualTerminalProfile,
  terminalProfileWorkspaceKey,
  type TerminalProfileWorkspace,
  getManualTerminalProfileById,
  getManualTerminalProfileBySessionId,
  listManualTerminalProfiles,
  type ManualTerminalProfile,
  type ManualTerminalProfileInput,
  upsertManualTerminalProfile,
} from '@/tools/terminal/services/manualTerminalProfileService';

interface UseManualTerminalProfilesReturn {
  profiles: ManualTerminalProfile[];
  error: string | null;
  profilesBySessionId: Map<string, ManualTerminalProfile>;
  refreshProfiles: () => void;
  saveProfile: (input: ManualTerminalProfileInput) => ManualTerminalProfile | null;
  removeProfile: (profileId: string) => void;
  getProfileById: (profileId: string) => ManualTerminalProfile | undefined;
  getProfileBySessionId: (sessionId: string) => ManualTerminalProfile | undefined;
}

export function useManualTerminalProfiles(
  workspaceInput?: TerminalProfileWorkspace,
): UseManualTerminalProfilesReturn {
  // Callers may build the scope inline on every render; profile reads and the
  // refresh effect must key on its identifying facts, not on object identity.
  const surfaceId = workspaceInput?.surfaceId;
  const workspaceId = workspaceInput?.workspaceId;
  const workspace = useMemo<TerminalProfileWorkspace | undefined>(
    () => (surfaceId && workspaceId ? { surfaceId, workspaceId } : undefined),
    [surfaceId, workspaceId],
  );
  const workspaceKey = workspace ? terminalProfileWorkspaceKey(workspace) : undefined;
  const [snapshot, setSnapshot] = useState<{
    key: string | undefined; profiles: ManualTerminalProfile[]; error: string | null;
  }>({ key: workspaceKey, profiles: [], error: null });
  const profiles = useMemo(() => snapshot.key === workspaceKey ? snapshot.profiles : [], [snapshot, workspaceKey]);

  const refreshProfiles = useCallback(() => {
    if (!workspaceKey) {
      setSnapshot({ key: workspaceKey, profiles: [], error: null });
      return;
    }

    try {
      setSnapshot({ key: workspaceKey, profiles: listManualTerminalProfiles(workspace!), error: null });
    } catch (error) {
      setSnapshot(previous => ({
        key: workspaceKey, profiles: previous.key === workspaceKey ? previous.profiles : [],
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [workspaceKey, workspace]);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  const saveProfile = useCallback((input: ManualTerminalProfileInput) => {
    if (!workspaceKey) {
      return null;
    }

    const profile = upsertManualTerminalProfile(workspace!, input);
    refreshProfiles();
    return profile;
  }, [refreshProfiles, workspaceKey, workspace]);

  const removeProfile = useCallback((profileId: string) => {
    if (!workspaceKey) {
      return;
    }

    deleteManualTerminalProfile(workspace!, profileId);
    refreshProfiles();
  }, [refreshProfiles, workspaceKey, workspace]);

  const getProfileById = useCallback((profileId: string) => {
    if (!workspaceKey) {
      return undefined;
    }

    return getManualTerminalProfileById(workspace!, profileId);
  }, [workspaceKey, workspace]);

  const getProfileBySessionId = useCallback((sessionId: string) => {
    if (!workspaceKey) {
      return undefined;
    }

    return getManualTerminalProfileBySessionId(workspace!, sessionId);
  }, [workspaceKey, workspace]);

  const profilesBySessionId = useMemo(
    () => new Map(profiles.map((profile) => [profile.sessionId, profile])),
    [profiles],
  );

  return {
    profiles,
    error: snapshot.key === workspaceKey ? snapshot.error : null,
    profilesBySessionId,
    refreshProfiles,
    saveProfile,
    removeProfile,
    getProfileById,
    getProfileBySessionId,
  };
}
