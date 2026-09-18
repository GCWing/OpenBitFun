// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyTerminalProfiles } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { STORAGE_KEYS } from '@/shared/constants/app';
import {
  deleteManualTerminalProfile, listManualTerminalProfiles, upsertManualTerminalProfile,
} from './manualTerminalProfileService';

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({ openedWorkspaces: new Map([
    ['workspace-1', { id: 'workspace-1', rootPath: '/project', workspaceKind: 'normal' }],
  ]), recentWorkspaces: [] }) },
}));
const workspace = { surfaceId: 'local', workspaceId: 'workspace-1' };
const legacyKey = `${STORAGE_KEYS.MANUAL_TERMINAL_PROFILES}:/project`;
const storageKey = `${STORAGE_KEYS.MANUAL_TERMINAL_PROFILES}:id:${JSON.stringify(['local', 'workspace-1'])}`;
const legacyProfile = { id: 'saved-1', sessionId: 'terminal-1', name: 'Build' };

describe('saved terminal configuration compatibility', () => {
  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
      clear: () => { entries.clear(); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads legacy records and preserves unknown fields when rebinding a host-allocated session', () => {
    localStorage.setItem(legacyKey, JSON.stringify({
      version: 1, futureSetting: { enabled: true },
      profiles: [{ ...legacyProfile, futureField: 'preserve' }],
    }));
    expect(listManualTerminalProfiles(workspace)[0]).toMatchObject(legacyProfile);
    expect(localStorage.getItem(storageKey)).toBe(localStorage.getItem(legacyKey));
    upsertManualTerminalProfile(workspace, { ...legacyProfile, sessionId: 'ssh-host-allocated-id' });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      version: 1, futureSetting: { enabled: true },
      profiles: [{ ...legacyProfile, sessionId: 'ssh-host-allocated-id', futureField: 'preserve' }],
    });
  });

  it.each([
    ['malformed JSON', '{unfinished'],
    ['invalid entry', JSON.stringify({ version: 1, profiles: [legacyProfile, null] })],
    ['newer format', JSON.stringify({ version: 2, profiles: [legacyProfile] })],
  ])('leaves %s intact and surfaces read and write failures', (_name, raw) => {
    localStorage.setItem(storageKey, raw);
    expect(() => listManualTerminalProfiles(workspace)).toThrow();
    expect(() => upsertManualTerminalProfile(workspace, legacyProfile)).toThrow();
    expect(() => deleteManualTerminalProfile(workspace, legacyProfile.id)).toThrow();
    expect(localStorage.getItem(storageKey)).toBe(raw);
  });

  it('isolates workspace records and removes only the explicitly selected configuration', () => {
    upsertManualTerminalProfile(workspace, legacyProfile);
    upsertManualTerminalProfile(workspace, { id: 'saved-2', sessionId: 'terminal-2', name: 'Tests' });
    upsertManualTerminalProfile({ surfaceId: 'peer', workspaceId: 'workspace-1' }, legacyProfile);
    deleteManualTerminalProfile(workspace, legacyProfile.id);
    expect(listManualTerminalProfiles(workspace).map(profile => profile.id)).toEqual(['saved-2']);
    expect(listManualTerminalProfiles({ surfaceId: 'peer', workspaceId: 'workspace-1' })).toHaveLength(1);
  });
  it('does not guess which of two same-path records owns an old profile', () => {
    const raw = JSON.stringify({ version: 1, profiles: [legacyProfile] });
    localStorage.setItem(legacyKey, raw);
    expect(() => migrateLegacyTerminalProfiles(localStorage, STORAGE_KEYS.MANUAL_TERMINAL_PROFILES,
      storageKey, workspace, [
        { id: 'workspace-1', rootPath: '/project', workspaceKind: 'normal' },
        { id: 'workspace-2', rootPath: '/project', workspaceKind: 'normal' },
      ])).toThrow('ambiguous');
    expect(localStorage.getItem(legacyKey)).toBe(raw);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('does not overwrite an ID-owned record when the old cache changes', () => {
    upsertManualTerminalProfile(workspace, legacyProfile);
    const saved = localStorage.getItem(storageKey);
    localStorage.setItem(legacyKey, '{broken legacy record');
    expect(listManualTerminalProfiles(workspace)[0]).toMatchObject(legacyProfile);
    expect(localStorage.getItem(storageKey)).toBe(saved);
  });

});
