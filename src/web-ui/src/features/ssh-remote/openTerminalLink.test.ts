import { describe, expect, it, vi } from 'vitest';
import { openTerminalLink, type TerminalLinkDeps } from './openTerminalLink';
import type { PortForward } from './types';

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

function deps(overrides: Partial<TerminalLinkDeps> = {}) {
  return {
    listPortForwards: vi.fn(async () => [] as PortForward[]),
    startPortForward: vi.fn(async () => forward()),
    openExternal: vi.fn(async () => {}),
    isPeerDeviceModeActive: vi.fn(() => false),
    notifyInfo: vi.fn(),
    notifyWarning: vi.fn(),
    t: vi.fn((key: string) => key),
    ...overrides,
  };
}

describe('openTerminalLink', () => {
  it('opens links unchanged for local terminals', async () => {
    const d = deps();
    await expect(openTerminalLink('http://127.0.0.1:5173/', {}, d)).resolves.toBe('opened');
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    expect(d.listPortForwards).not.toHaveBeenCalled();
  });

  it('opens non-loopback links unchanged for remote terminals', async () => {
    const d = deps();
    await openTerminalLink('https://example.com/', { connectionId: 'conn' }, d);
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(d.listPortForwards).not.toHaveBeenCalled();
  });

  it('reuses an existing forward without notifying', async () => {
    const d = deps({ listPortForwards: vi.fn(async () => [forward({ localPort: 40000 })]) });
    await expect(
      openTerminalLink('http://localhost:5173/a?b=1', { connectionId: 'conn' }, d),
    ).resolves.toBe('forward-reused');
    expect(d.startPortForward).not.toHaveBeenCalled();
    expect(d.notifyInfo).not.toHaveBeenCalled();
    expect(d.openExternal).toHaveBeenCalledWith('http://localhost:40000/a?b=1');
  });

  it('starts a forward preferring the same local port and announces the mapping', async () => {
    const d = deps({ startPortForward: vi.fn(async () => forward({ localPort: 5174 })) });
    await expect(
      openTerminalLink('http://127.0.0.1:5173/', { connectionId: 'conn' }, d),
    ).resolves.toBe('forward-created');
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
        throw new Error('Local Docker and WSL workspaces do not support SSH port forwarding.');
      }),
    });
    await expect(
      openTerminalLink('http://127.0.0.1:3000/', { connectionId: 'docker' }, d),
    ).resolves.toBe('forward-failed');
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.notifyWarning).toHaveBeenCalledTimes(1);
    const action = d.notifyWarning.mock.calls[0][1];
    action?.onClick();
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3000/');
  });

  it('reuses a forward created concurrently when start reports a duplicate', async () => {
    const list = vi
      .fn<[], Promise<PortForward[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([forward({ localPort: 41000 })]);
    const d = deps({
      listPortForwards: list,
      startPortForward: vi.fn(async () => {
        throw new Error('already forwarded');
      }),
    });
    await expect(
      openTerminalLink('http://127.0.0.1:5173/', { connectionId: 'conn' }, d),
    ).resolves.toBe('forward-created');
    expect(d.openExternal).toHaveBeenCalledWith('http://127.0.0.1:41000/');
  });

  it('refuses to forward in Peer Device Mode', async () => {
    const d = deps({ isPeerDeviceModeActive: vi.fn(() => true) });
    await expect(
      openTerminalLink('http://127.0.0.1:5173/', { connectionId: 'conn' }, d),
    ).resolves.toBe('peer-unsupported');
    expect(d.listPortForwards).not.toHaveBeenCalled();
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.notifyWarning).toHaveBeenCalledWith('linkForward.peerUnsupported', expect.any(Object));
  });
});
