import { beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySshEndpointConflict, sshConnectionIdForEndpoint } from './sshConnectionId';
import type { SavedConnection } from './types';
import { canonicalSshConnectionId, sshConnectionIdPortScope } from '@/shared/utils/sshConnectionIdentity';

const api = vi.hoisted(() => ({ listSavedConnections: vi.fn() }));
const workspaces = vi.hoisted(() => ({ opened: vi.fn(), recent: vi.fn() }));
const surface = vi.hoisted(() => ({ local: true, portScoped: false }));
vi.mock('./sshApi', () => ({ sshApi: api }));
vi.mock('@/infrastructure/api/service-api/GlobalAPI', () => ({
  globalAPI: { getOpenedWorkspaces: workspaces.opened, getRecentWorkspaces: workspaces.recent },
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/peer-device/deviceSurface')>(),
  getActiveSurfaceScope: () => ({ surfaceId: surface.local ? 'local' : 'peer-1', assertCurrent: () => undefined }),
  isLocalSurface: (id: string) => id === 'local',
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => ({ getState: () => ({ capabilities: { sshPortScopedIdentityV1: surface.portScoped } }) }) },
}));

const saved = (id: string, host: string, port: number, username = 'root', extra: Partial<SavedConnection> = {}): SavedConnection => ({
  id, name: id, host, port, username, authType: { type: 'Agent' }, ...extra,
});

describe('ssh connection id grammar', () => {
  it('parses port scopes, including synthetic container hosts, and never legacy ids', () => {
    expect(sshConnectionIdPortScope('ssh-root@cluster#2201')).toBe('2201');
    expect(sshConnectionIdPortScope('ssh-root@cluster#2201~2-container-web')).toBe('2201~2');
    expect(sshConnectionIdPortScope(`workspace-host-${encodeURIComponent('ssh-root@cluster#2201')}-container-web`)).toBe('2201');
    for (const legacy of ['ssh-root@cluster', 'ssh-root@cluster:2201', `workspace-host-${encodeURIComponent('ssh-root@cluster:2201')}-container-web`, 'workspace-host-%ZZ']) {
      expect(sshConnectionIdPortScope(legacy)).toBeUndefined();
    }
    expect(canonicalSshConnectionId('ssh-root@cluster:2222')).toBe('ssh-root@cluster');
    expect(canonicalSshConnectionId('ssh-root@cluster#2222')).toBe('ssh-root@cluster#2222');
  });
});

describe('sshConnectionIdForEndpoint', () => {
  it('keeps the legacy id for the default port', () => {
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 22, username: 'root' })).toBe('ssh-root@cluster');
  });

  it('distinguishes servers behind one address by port', () => {
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root' })).toBe('ssh-root@cluster#2201');
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2202, username: 'root' })).toBe('ssh-root@cluster#2202');
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root', suffix: '-container-web' }))
      .toBe('ssh-root@cluster#2201-container-web');
  });

  it('reuses the id of a saved profile for the same endpoint, including legacy port-less ids', () => {
    const connections = [saved('ssh-root@cluster', 'cluster', 2201)];
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root' }, connections)).toBe('ssh-root@cluster');
  });

  it('never takes an id owned by a profile for another port', () => {
    const connections = [saved('ssh-root@cluster', 'cluster', 2201), saved('ssh-root@cluster#2202', 'cluster', 2299)];
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 22, username: 'root' }, connections)).toBe('ssh-root@cluster#22');
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2202, username: 'root' }, connections)).toBe('ssh-root@cluster#2202~2');
  });

  it('treats a pre-#710 `:port` alias on another port as taken', () => {
    // Old saved payload: id written with the port, which workspace records treat as `ssh-root@cluster`.
    const connections = [saved('ssh-root@cluster:2222', 'cluster', 2222)];
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 22, username: 'root' }, connections)).toBe('ssh-root@cluster#22');
  });

  it('reuses an orphaned legacy id that workspace records still reference', () => {
    const context = { referencedIds: ['ssh-root@cluster'] };
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root' }, [], undefined, context)).toBe('ssh-root@cluster');
    // A `:port` alias only reattaches to its own port.
    const alias = { referencedIds: ['ssh-root@cluster:2201'] };
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root' }, [], undefined, alias)).toBe('ssh-root@cluster:2201');
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2202, username: 'root' }, [], undefined, alias)).toBe('ssh-root@cluster#2202');
    // Owned ids are never reused for another port.
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 2201, username: 'root' },
      [saved('ssh-root@cluster', 'cluster', 22)], undefined, context)).toBe('ssh-root@cluster#2201');
  });

  it('only reuses profiles of the same target kind', () => {
    const connections = [saved('ssh-root@cluster', 'cluster', 22, 'root', {
      container: { name: 'web', local: false, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
    })];
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 22, username: 'root' }, connections, connection => !connection.container))
      .toBe('ssh-root@cluster#22');
  });

  it('keeps legacy ids for hosts without port-scoped identity and reports the profile they would replace', () => {
    const connections = [saved('ssh-root@cluster', 'cluster', 2201)];
    const endpoint = { host: 'cluster', port: 2202, username: 'root' };
    expect(sshConnectionIdForEndpoint(endpoint, connections, undefined, { portScopedIds: false })).toBe('ssh-root@cluster');
    expect(legacySshEndpointConflict(endpoint, connections)?.id).toBe('ssh-root@cluster');
    expect(legacySshEndpointConflict({ ...endpoint, port: 2201 }, connections)).toBeUndefined();
    expect(legacySshEndpointConflict({ ...endpoint, host: 'other' }, connections)).toBeUndefined();
  });
});

describe('resolveNewSshConnectionId', () => {
  beforeEach(() => {
    surface.local = true;
    surface.portScoped = false;
    api.listSavedConnections.mockReset();
    workspaces.opened.mockResolvedValue([]);
    workspaces.recent.mockResolvedValue([]);
  });

  it('resolves against the saved profiles of the active host', async () => {
    const { resolveNewSshConnectionId } = await import('./resolveSshConnectionId');
    api.listSavedConnections.mockResolvedValue([saved('ssh-root@cluster', 'cluster', 2201)]);
    await expect(resolveNewSshConnectionId({ host: 'cluster', port: 22, username: 'root' }, () => true))
      .resolves.toEqual({ id: 'ssh-root@cluster#22' });
  });

  it('refuses to pick an id when the saved profiles are unknown', async () => {
    const { resolveNewSshConnectionId } = await import('./resolveSshConnectionId');
    api.listSavedConnections.mockRejectedValue(new Error('offline'));
    const resolved = await resolveNewSshConnectionId({ host: 'cluster', port: 22, username: 'root' }, () => true);
    expect(resolved).toMatchObject({ error: 'savedConnectionsUnavailable' });
  });

  it('blocks a second port on an older peer host and keeps the legacy id', async () => {
    const { resolveNewSshConnectionId } = await import('./resolveSshConnectionId');
    surface.local = false;
    const connections = [saved('ssh-root@cluster', 'cluster', 2201)];
    const resolved = await resolveNewSshConnectionId({ host: 'cluster', port: 2202, username: 'root' }, () => true, connections);
    expect(resolved).toMatchObject({ error: 'portScopedIdentityUnsupported', transientId: 'ssh-root@cluster' });
    surface.portScoped = true;
    await expect(resolveNewSshConnectionId({ host: 'cluster', port: 2202, username: 'root' }, () => true, connections))
      .resolves.toEqual({ id: 'ssh-root@cluster#2202' });
  });
});
