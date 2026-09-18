import { resolveLegacyTerminalWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { describe, expect, it } from 'vitest';
import type { SessionResponse } from '../types/session';
import { isSessionRunning } from '@/app/scenes/shell/hooks/shellEntryTypes';
import { TerminalOriginCache, isTerminalPathInside, terminalBelongsToWorkspace } from './terminalWorkspaceScope';

const terminal = (overrides: Partial<SessionResponse> = {}): SessionResponse => ({
  workspaceId: 'workspace-local', id: 'terminal-1', name: 'Development', shellType: 'Bash', cwd: '/repo/src', initialCwd: '/repo',
  source: 'manual', status: 'Running', cols: 80, rows: 24, ...overrides,
});

describe('workspace terminal projection', () => {
  it('keeps explicit ownership after cd or when another workspace has the same path', () => {
    const local = { workspaceId: 'workspace-local', rootPath: '/repo', isRemote: false };
    const other = { ...local, workspaceId: 'workspace-other' };
    const moved = terminal({ cwd: '/another-project', initialCwd: '/unrelated' });
    expect(terminalBelongsToWorkspace(moved, local)).toBe(true);
    expect(terminalBelongsToWorkspace(moved, other)).toBe(false);
    expect(terminalBelongsToWorkspace(terminal({ workspaceId: undefined }), local)).toBe(false);
  });
  it('converts old payloads only at the compatibility boundary and refuses ambiguity', () => {
    const old = terminal({ workspaceId: undefined });
    const records = [
      { id: 'local', rootPath: '/repo', workspaceKind: 'normal' },
      { id: 'remote', rootPath: '/repo', workspaceKind: 'remote', connectionId: 'ssh-a' },
    ];
    expect(resolveLegacyTerminalWorkspace(old, records)).toBe('local');
    expect(resolveLegacyTerminalWorkspace({ ...old, shellType: 'Remote', connectionId: 'ssh-a' }, records)).toBe('remote');
    expect(resolveLegacyTerminalWorkspace(old, [...records, { ...records[0], id: 'duplicate' }])).toBeUndefined();
    expect(resolveLegacyTerminalWorkspace({ ...old, workspaceId: 'stale' }, records)).toBe('stale');
  });
  it('uses the target path semantics on every controller OS', () => {
    expect(isTerminalPathInside('C:\\Repo\\src', 'c:/repo/')).toBe(true);
    expect(isTerminalPathInside('/Repo/src', '/repo', true)).toBe(false);
    expect(isTerminalPathInside('/repo/a\\b', '/repo/a', true)).toBe(false);
    expect(isTerminalPathInside('/repo/src', '/', true)).toBe(true);
  });
  it('accepts old host payloads and anchors their first observation per device', () => {
    const origins = new TerminalOriginCache();
    const old = terminal({ initialCwd: undefined });
    expect(origins.project('local', old).initialCwd).toBe('/repo/src');
    expect(origins.project('local', { ...old, cwd: '/different' }).initialCwd).toBe('/repo/src');
    expect(origins.project('peer-b', { ...old, cwd: '/different' }).initialCwd).toBe('/different');
    expect(origins.project('local', { ...old, initialCwd: '/authoritative' }).initialCwd).toBe('/authoritative');
  });
  it('does not report an exited or unknown session as running', () => {
    for (const status of ['Exited { exit_code: Some(0) }', 'Stopped', 'Terminating', 'Error', 'unknown']) {
      expect(isSessionRunning(terminal({ status }))).toBe(false);
    }
    expect(isSessionRunning(terminal())).toBe(true);
    expect(isSessionRunning(terminal({ status: 'Active' }))).toBe(true);
    expect(isSessionRunning(terminal({ status: 'Starting' }))).toBe(true);
    expect(isSessionRunning(terminal({ status: 'Restoring' }))).toBe(true);
  });
});
