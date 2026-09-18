import { migrateLegacyTerminalProfiles } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { STORAGE_KEYS } from '@/shared/constants/app';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('ManualTerminalProfileService');

export interface ManualTerminalProfile {
  id: string;
  sessionId: string;
  name: string;
  workingDirectory?: string;
  startupCommand?: string;
  shellType?: string;
}

export interface ManualTerminalProfilesState {
  version: 1;
  profiles: ManualTerminalProfile[];
}

export interface ManualTerminalProfileInput {
  id?: string;
  sessionId: string;
  name: string;
  workingDirectory?: string;
  startupCommand?: string;
  shellType?: string;
}

export interface TerminalProfileWorkspace {
  surfaceId: string;
  workspaceId: string;
}

export function terminalProfileWorkspaceKey(workspace: TerminalProfileWorkspace): string {
  return JSON.stringify([workspace.surfaceId, workspace.workspaceId]);
}

const EMPTY_STATE: ManualTerminalProfilesState = {
  version: 1,
  profiles: [],
};

function getStorageKey(workspace: TerminalProfileWorkspace): string {
  return `${STORAGE_KEYS.MANUAL_TERMINAL_PROFILES}:id:${terminalProfileWorkspaceKey(workspace)}`;
}

export function generateManualTerminalProfileId(): string {
  return `manual_profile_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProfile(raw: unknown): ManualTerminalProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const profile = raw as Partial<ManualTerminalProfile>;
  if (typeof profile.id !== 'string' || !profile.id
    || typeof profile.sessionId !== 'string' || !profile.sessionId
    || typeof profile.name !== 'string' || !profile.name.trim()
    || [profile.workingDirectory, profile.startupCommand, profile.shellType]
      .some(value => value != null && typeof value !== 'string')) {
    return null;
  }

  return {
    ...profile,
    id: profile.id,
    sessionId: profile.sessionId,
    name: profile.name.trim(),
    workingDirectory: profile.workingDirectory?.trim() || undefined,
    startupCommand: profile.startupCommand?.trim() || undefined,
    shellType: profile.shellType?.trim() || undefined,
  };
}

function normalizeState(raw: unknown): ManualTerminalProfilesState {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid saved terminal configurations');
  }
  const state = raw as { version?: unknown; profiles?: unknown };
  if ((state.version !== undefined && state.version !== 1) || !Array.isArray(state.profiles)) {
    throw new Error('Unsupported saved terminal configuration format');
  }
  const profiles = state.profiles.map(item => {
    const profile = normalizeProfile(item);
    if (!profile) throw new Error('Invalid saved terminal configuration; existing data has been preserved');
    return profile;
  });

  return {
    ...raw,
    version: 1,
    profiles,
  };
}

export function loadManualTerminalProfiles(workspace: TerminalProfileWorkspace): ManualTerminalProfilesState {
  try {
    const key = getStorageKey(workspace);
    if (localStorage.getItem(key) === null) {
      const state = workspaceManager.getState();
      migrateLegacyTerminalProfiles(localStorage, STORAGE_KEYS.MANUAL_TERMINAL_PROFILES, key, workspace,
        [...state.openedWorkspaces.values(), ...state.recentWorkspaces]);
    }
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      return normalizeState(JSON.parse(raw));
    }
  } catch (error) {
    logger.error('Failed to load manual terminal profiles', { workspace, error });
    throw new Error('Saved terminal configurations could not be read; existing data has been preserved');
  }

  return EMPTY_STATE;
}

export function saveManualTerminalProfiles(
  workspace: TerminalProfileWorkspace,
  state: ManualTerminalProfilesState,
): void {
  // Do not replace an unreadable or newer-format record with a normalized subset.
  loadManualTerminalProfiles(workspace);
  try {
    localStorage.setItem(getStorageKey(workspace), JSON.stringify(normalizeState(state)));
  } catch (error) {
    logger.error('Failed to save manual terminal profiles', { workspace, error });
    throw error;
  }
}

export function listManualTerminalProfiles(workspace: TerminalProfileWorkspace): ManualTerminalProfile[] {
  return loadManualTerminalProfiles(workspace).profiles;
}

export function getManualTerminalProfileById(
  workspace: TerminalProfileWorkspace,
  profileId: string,
): ManualTerminalProfile | undefined {
  return listManualTerminalProfiles(workspace).find((profile) => profile.id === profileId);
}

export function getManualTerminalProfileBySessionId(
  workspace: TerminalProfileWorkspace,
  sessionId: string,
): ManualTerminalProfile | undefined {
  return listManualTerminalProfiles(workspace).find((profile) => profile.sessionId === sessionId);
}

export function upsertManualTerminalProfile(
  workspace: TerminalProfileWorkspace,
  input: ManualTerminalProfileInput,
): ManualTerminalProfile {
  const currentState = loadManualTerminalProfiles(workspace);
  const existingProfile = currentState.profiles.find(
    (profile) => profile.id === input.id || profile.sessionId === input.sessionId,
  );
  const normalizedProfile = normalizeProfile({
    ...existingProfile,
    id: existingProfile?.id ?? input.id ?? generateManualTerminalProfileId(),
    sessionId: input.sessionId,
    name: input.name,
    workingDirectory: input.workingDirectory,
    startupCommand: input.startupCommand,
    shellType: input.shellType,
  });

  if (!normalizedProfile) {
    throw new Error('Invalid manual terminal profile');
  }

  const existingIndex = currentState.profiles.findIndex((profile) => profile.id === normalizedProfile.id);
  const nextProfiles = [...currentState.profiles];

  if (existingIndex >= 0) {
    nextProfiles[existingIndex] = normalizedProfile;
  } else {
    nextProfiles.push(normalizedProfile);
  }

  saveManualTerminalProfiles(workspace, {
    ...currentState,
    profiles: nextProfiles,
  });

  return normalizedProfile;
}

export function deleteManualTerminalProfile(workspace: TerminalProfileWorkspace, profileId: string): void {
  const currentState = loadManualTerminalProfiles(workspace);
  saveManualTerminalProfiles(workspace, {
    ...currentState,
    profiles: currentState.profiles.filter((profile) => profile.id !== profileId),
  });
}
