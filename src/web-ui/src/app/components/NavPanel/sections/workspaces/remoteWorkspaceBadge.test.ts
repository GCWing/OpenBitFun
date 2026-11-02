import { describe, expect, it } from 'vitest';
import { WorkspaceKind } from '@/shared/types';
import { remoteWorkspaceBadge, remoteWorkspaceBadges } from './remoteWorkspaceBadge';

const remote = (
  id: string,
  connectionId: string,
  connectionName: string,
  sshHost: string,
) => ({ id, workspaceKind: WorkspaceKind.Remote, connectionId, connectionName, sshHost });

describe('remoteWorkspaceBadges (#3517)', () => {
  it('drops the login user from generated names and keeps the full endpoint for the tooltip', () => {
    const badge = remoteWorkspaceBadge(remote(
      'w1', 'ssh-root@gpu-node-17.cluster.podtc.example.com', 'root@gpu-node-17.cluster.podtc.example.com',
      'gpu-node-17.cluster.podtc.example.com',
    ));
    expect(badge).toEqual({
      label: 'gpu-node-17.cluster.podtc.example.com',
      connection: 'root@gpu-node-17.cluster.podtc.example.com',
      host: 'root@gpu-node-17.cluster.podtc.example.com',
    });
  });

  it('shows a saved connection name or SSH config alias as is', () => {
    const badge = remoteWorkspaceBadge(remote('w1', 'ssh-root@10.0.0.8', 'gpu-box', '10.0.0.8'));
    expect(badge?.label).toBe('gpu-box');
    expect(badge?.connection).toBe('gpu-box');
    expect(badge?.host).toBe('root@10.0.0.8');
  });

  it('keeps port-scoped connections on one address distinct', () => {
    const badges = remoteWorkspaceBadges([
      remote('a', 'ssh-root@node.example.com', 'root@node.example.com', 'node.example.com'),
      remote('b', 'ssh-root@node.example.com#2202', 'root@node.example.com', 'node.example.com#2202'),
    ]);
    expect(badges.get('a')?.label).toBe('node.example.com');
    expect(badges.get('b')?.label).toBe('node.example.com:2202');
    expect(badges.get('b')?.host).toBe('root@node.example.com:2202');
  });

  it('expands to user@host when two different connections would read the same', () => {
    const badges = remoteWorkspaceBadges([
      remote('a', 'ssh-root@host.example.com', 'root@host.example.com', 'host.example.com'),
      remote('b', 'ssh-alice@host.example.com', 'alice@host.example.com', 'host.example.com'),
      remote('c', 'ssh-alice@host.example.com', 'alice@host.example.com', 'host.example.com'),
    ]);
    expect(badges.get('a')?.label).toBe('root@host.example.com');
    expect(badges.get('b')?.label).toBe('alice@host.example.com');
    expect(badges.get('c')?.label).toBe('alice@host.example.com');
  });

  it('keeps folders on the same connection compact', () => {
    const badges = remoteWorkspaceBadges([
      remote('a', 'ssh-root@host.example.com', 'root@host.example.com', 'host.example.com'),
      remote('b', 'ssh-root@host.example.com', 'root@host.example.com', 'host.example.com'),
    ]);
    expect(badges.get('a')?.label).toBe('host.example.com');
    expect(badges.get('b')?.label).toBe('host.example.com');
  });

  it('disambiguates equal aliases with the endpoint and ignores local workspaces', () => {
    const badges = remoteWorkspaceBadges([
      remote('a', 'ssh-root@a.example.com', 'dev', 'a.example.com'),
      remote('b', 'ssh-root@b.example.com', 'dev', 'b.example.com'),
      { id: 'local', workspaceKind: WorkspaceKind.Normal, sshHost: 'localhost' },
    ]);
    expect(badges.get('a')?.label).toBe('dev · root@a.example.com');
    expect(badges.get('b')?.label).toBe('dev · root@b.example.com');
    expect(badges.has('local')).toBe(false);
  });

  it('falls back to the connection id when older records omit name and host', () => {
    const badge = remoteWorkspaceBadge({ id: 'w', workspaceKind: WorkspaceKind.Remote, connectionId: 'ssh-root@legacy.example.com' });
    expect(badge?.label).toBe('legacy.example.com');
    expect(badge?.host).toBe('root@legacy.example.com');
  });
});
