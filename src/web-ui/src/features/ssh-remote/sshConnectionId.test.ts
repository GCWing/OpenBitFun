import { describe, expect, it } from 'vitest';
import { sshConnectionIdForEndpoint } from './sshConnectionId';
import type { SavedConnection } from './types';

const saved = (id: string, host: string, port: number, username = 'root', extra: Partial<SavedConnection> = {}): SavedConnection => ({
  id, name: id, host, port, username, authType: { type: 'Agent' }, ...extra,
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

  it('only reuses profiles of the same target kind', () => {
    const connections = [saved('ssh-root@cluster', 'cluster', 22, 'root', {
      container: { name: 'web', local: false, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
    })];
    expect(sshConnectionIdForEndpoint({ host: 'cluster', port: 22, username: 'root' }, connections, connection => !connection.container))
      .toBe('ssh-root@cluster#22');
  });
});
