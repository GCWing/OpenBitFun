import { describe, expect, it, vi } from 'vitest';
import { openTerminalLink, type TerminalLinkDeps } from './openTerminalLink';
import type { PortForward, SavedConnection } from './types';

function forward(overrides: Partial<PortForward> = {}): PortForward {
  return {
    id: 'f1',
    connectionId: 'conn',
    direction: 'local',
    localHost: '127.0.0.1',
    localPort: 5173,
    remoteHost: '127.0.0.1',
    remotePort: 5173,
    activeConnections: 0,
    totalConnections: 0,
    ...overrides,
  };
}

function saved(overrides: Partial<SavedConnection>): SavedConnection {
  return {
    id: 'conn',
    name: 'c',
    host: 'h',
    port: 22,
    username: 'u',
    authType: { type: 'Agent' },
    ...overrides,
  };
}

function deps(overrides: Partial<TerminalLinkDeps> = {}) {
  return {
    listSavedConnections: vi.fn(async () => [saved({})]),
    listPortForwards: vi.fn(async () => [] as PortForward[]),
    startPortForward: vi.fn(async () => forward()),
    stopPortForward: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    isPeerDeviceModeActive: vi.fn(() => false),
    notifyInfo: vi.fn(),
    notifyWarning: vi.fn(),
    t: vi.fn((key: string) => key),
    ...overrides,
  };
}

const ssh = { connectionId: 'conn' };

describe('openTerminalLink', () => {
  it('opens links unchanged for local terminals', async () => {
    const d = deps();
    await expect(openTerminalLink('http://127.0.0.1:5173/', {}, d)).resolves.toBe('opened');
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    expect(d.listPortForwards).not.toHaveBeenCalled();
  });

  it('opens non-loopback links unchanged for remote terminals', async () => {
    const d = deps();
    await openTerminalLink('https://example.com/', ssh, d);
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(d.listPortForwards).not.toHaveBeenCalled();
  });

  it.each([
    ['WSL', saved({ wsl: { distribution: 'Ubuntu' } })],
    ['local Docker', saved({
      container: { name: 'c', access: 'docker-exec', local: true, dockerPath: 'docker', shell: '/bin/sh', interactive: true },
    })],
  ])('opens links unchanged for %s targets without forwarding', async (_name, connection) => {
    const d = deps({ listSavedConnections: vi.fn(async () => [connection]) });
    await expect(openTerminalLink('http://localhost:3000/', ssh, d)).resolves.toBe('opened-local-target');
    expect(d.openExternal).toHaveBeenCalledWith('http://localhost:3000/');
    expect(d.listPortForwards).not.toHaveBeenCalled();
    expect(d.startPortForward).not.toHaveBeenCalled();
  });

  it('reuses an existing forward without notifying and rewrites to the bound address', async () => {
    const d = deps({ listPortForwards: vi.fn(async () => [forward({ localPort: 40000 })]) });
    await expect(openTerminalLink('http://localhost:5173/a?b=1', ssh, d)).resolves.toBe('forward-reused');
    expect(d.startPortForward).not.toHaveBeenCalled();
    expect(d.notifyInfo).not.toHaveBeenCalled();
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:40000/a?b=1');
  });

  it('reuses a forward for a non-default 127.x remote host on a second click', async () => {
    const d = deps({
      listPortForwards: vi.fn(async () => [forward({ remoteHost: '127.1.2.3', localPort: 9001 })]),
    });
    await expect(openTerminalLink('http://127.1.2.3:5173/', ssh, d)).resolves.toBe('forward-reused');
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:9001/');
  });

  it('does not reuse a 127.0.0.1 forward for an [::1] link', async () => {
    const d = deps({
      listPortForwards: vi.fn(async () => [forward({ localPort: 40000 })]),
      startPortForward: vi.fn(async () => forward({ remoteHost: '::1', localPort: 5173 })),
    });
    await expect(openTerminalLink('http://[::1]:5173/', ssh, d)).resolves.toBe('forward-created');
    expect(d.startPortForward).toHaveBeenCalledWith(expect.objectContaining({ remoteHost: '::1' }));
  });

  it('restarts an idle forward that recorded an error, keeping its local port', async () => {
    const d = deps({
      listPortForwards: vi.fn(async () => [forward({ localPort: 40000, lastError: 'SSH connection is not active' })]),
      startPortForward: vi.fn(async () => forward({ id: 'f2', localPort: 40000 })),
    });
    await expect(openTerminalLink('http://127.0.0.1:5173/', ssh, d)).resolves.toBe('forward-created');
    expect(d.stopPortForward).toHaveBeenCalledWith('f1');
    expect(d.startPortForward).toHaveBeenCalledWith(expect.objectContaining({ localPort: 40000 }));
  });

  it('starts a forward preferring the same local port and announces the mapping', async () => {
    const d = deps({ startPortForward: vi.fn(async () => forward({ localPort: 5174 })) });
    await expect(openTerminalLink('http://127.0.0.1:5173/', ssh, d)).resolves.toBe('forward-created');
    expect(d.startPortForward).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn', remotePort: 5173, remoteHost: '127.0.0.1', localPort: 5173 }),
    );
    expect(d.notifyInfo).toHaveBeenCalledTimes(1);
    expect(d.t).toHaveBeenCalledWith('linkForward.created', { remotePort: 5173, localAddress: '127.0.0.1:5174' });
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:5174/');
  });

  it('warns and does not open the local URL when forwarding fails', async () => {
    const d = deps({
      startPortForward: vi.fn(async () => {
        throw new Error('bind failed');
      }),
    });
    await expect(openTerminalLink('http://127.0.0.1:3000/', ssh, d)).resolves.toBe('forward-failed');
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.notifyWarning).toHaveBeenCalledTimes(1);
    expect(d.t).toHaveBeenCalledWith('linkForward.failed', { port: 3000, error: 'bind failed' });
    d.notifyWarning.mock.calls[0][1]?.onClick();
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3000/');
  });

  it('reports the original start error when the fallback re-list throws', async () => {
    const list = vi
      .fn<() => Promise<PortForward[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('list failed'));
    const d = deps({
      listPortForwards: list,
      startPortForward: vi.fn(async () => {
        throw new Error('start failed');
      }),
    });
    await expect(openTerminalLink('http://127.0.0.1:3000/', ssh, d)).resolves.toBe('forward-failed');
    expect(d.t).toHaveBeenCalledWith('linkForward.failed', { port: 3000, error: 'start failed' });
  });

  it('treats a lost start race as reuse with no toast', async () => {
    const list = vi
      .fn<() => Promise<PortForward[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([forward({ localPort: 41000 })]);
    const d = deps({
      listPortForwards: list,
      startPortForward: vi.fn(async () => {
        throw new Error('already forwarded');
      }),
    });
    await expect(openTerminalLink('http://127.0.0.1:5173/', ssh, d)).resolves.toBe('forward-reused');
    expect(d.notifyInfo).not.toHaveBeenCalled();
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:41000/');
  });

  it('warns about a port-less loopback link instead of opening it locally', async () => {
    const d = deps();
    await expect(openTerminalLink('http://localhost./', ssh, d)).resolves.toBe('no-port');
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.notifyWarning).toHaveBeenCalledWith('linkForward.noPort', expect.any(Object));
  });

  it('refuses to forward in Peer Device Mode', async () => {
    const d = deps({ isPeerDeviceModeActive: vi.fn(() => true) });
    await expect(openTerminalLink('http://127.0.0.1:5173/', ssh, d)).resolves.toBe('peer-unsupported');
    expect(d.listPortForwards).not.toHaveBeenCalled();
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.notifyWarning).toHaveBeenCalledWith('linkForward.peerUnsupported', expect.any(Object));
  });
});
