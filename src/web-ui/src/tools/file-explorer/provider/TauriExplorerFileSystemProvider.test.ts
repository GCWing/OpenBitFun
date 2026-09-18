import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

const workspaceApiMocks = vi.hoisted(() => ({
  explorerGetChildren: vi.fn(),
  startFileWatch: vi.fn(),
  stopFileWatch: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    listen: eventMocks.listen,
  },
}));

vi.mock('@/infrastructure/api', () => ({
  workspaceAPI: workspaceApiMocks,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => loggerMocks,
}));

async function createProvider() {
  vi.resetModules();
  const { TauriExplorerFileSystemProvider } = await import('./TauriExplorerFileSystemProvider');
  return new TauriExplorerFileSystemProvider();
}

describe('TauriExplorerFileSystemProvider watches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceApiMocks.startFileWatch.mockResolvedValue(undefined);
    workspaceApiMocks.stopFileWatch.mockResolvedValue(undefined);
    eventMocks.listen.mockReturnValue(vi.fn());
  });

  it('passes explicit non-recursive watcher requests to the backend', async () => {
    const provider = await createProvider();
    const unwatch = provider.watch('C:\\large\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });

    await vi.waitFor(() => {
      expect(workspaceApiMocks.startFileWatch).toHaveBeenCalledWith('workspace-id', 'C:\\large\\repo', false);
    });

    unwatch();
  });

  it('does not dispatch deep child events for non-recursive watches', async () => {
    let fileListener:
      | ((events: Array<{ path: string; kind: string; timestamp: number }>) => void)
      | undefined;
    eventMocks.listen.mockImplementation((_event, listener) => {
      fileListener = listener;
      return vi.fn();
    });
    const callback = vi.fn();
    const provider = await createProvider();

    const unwatch = provider.watch('C:\\large\\repo', callback, { recursive: false, workspaceId: 'workspace-id' });
    await vi.waitFor(() => {
      expect(fileListener).toBeDefined();
    });

    fileListener?.([
      { path: 'C:\\large\\repo\\src', kind: 'modify', timestamp: 1 },
      { path: 'C:\\large\\repo\\src\\nested.ts', kind: 'modify', timestamp: 1 },
    ]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      path: 'C:\\large\\repo\\src',
      type: 'modified',
    }));

    unwatch();
  });

  it('keeps the backend watch alive until all same-path watch modes are released', async () => {
    const provider = await createProvider();

    const unwatchNonRecursive = provider.watch('C:\\large\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });
    await vi.waitFor(() => {
      expect(workspaceApiMocks.startFileWatch).toHaveBeenCalledWith('workspace-id', 'C:\\large\\repo', false);
    });

    const unwatchRecursive = provider.watch('C:\\large\\repo', vi.fn(), { recursive: true, workspaceId: 'workspace-id' });
    await vi.waitFor(() => {
      expect(workspaceApiMocks.startFileWatch).toHaveBeenCalledWith('workspace-id', 'C:\\large\\repo', true);
    });

    unwatchNonRecursive();
    await Promise.resolve();
    expect(workspaceApiMocks.stopFileWatch).not.toHaveBeenCalled();

    unwatchRecursive();
    await vi.waitFor(() => {
      expect(workspaceApiMocks.stopFileWatch).toHaveBeenCalledTimes(1);
    });
  });

  it('stops a backend watch that is released before async registration settles', async () => {
    let resolveStart: (() => void) | undefined;
    workspaceApiMocks.startFileWatch.mockReturnValue(new Promise<void>((resolve) => {
      resolveStart = resolve;
    }));
    const provider = await createProvider();

    const unwatch = provider.watch('C:\\large\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });
    unwatch();
    expect(workspaceApiMocks.stopFileWatch).not.toHaveBeenCalled();

    resolveStart?.();
    await vi.waitFor(() => {
      expect(workspaceApiMocks.stopFileWatch).toHaveBeenCalledWith('workspace-id', 'C:\\large\\repo');
    });
  });

  it('restarts the backend watch when the same path is retained while stop is pending', async () => {
    let resolveStop: (() => void) | undefined;
    workspaceApiMocks.stopFileWatch.mockReturnValue(new Promise<void>((resolve) => {
      resolveStop = resolve;
    }));
    const provider = await createProvider();

    const firstUnwatch = provider.watch('C:\\large\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });
    await vi.waitFor(() => {
      expect(workspaceApiMocks.startFileWatch).toHaveBeenCalledTimes(1);
    });

    firstUnwatch();
    firstUnwatch();
    await vi.waitFor(() => {
      expect(workspaceApiMocks.stopFileWatch).toHaveBeenCalledTimes(1);
    });

    const secondUnwatch = provider.watch('C:\\large\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });
    resolveStop?.();

    await vi.waitFor(() => {
      expect(workspaceApiMocks.startFileWatch).toHaveBeenCalledTimes(2);
    });

    secondUnwatch();
  });

  it('does not log raw paths when backend watch synchronization fails', async () => {
    workspaceApiMocks.startFileWatch.mockRejectedValueOnce(new Error('watch failed'));
    const provider = await createProvider();

    const unwatch = provider.watch('C:\\secret\\repo', vi.fn(), { recursive: false, workspaceId: 'workspace-id' });

    await vi.waitFor(() => {
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        'Failed to synchronize backend file watch',
        expect.objectContaining({
          watchKey: expect.stringMatching(/^watch:/),
          error: expect.any(Error),
        })
      );
    });

    const [, payload] = loggerMocks.warn.mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty('rootPath');
    expect(JSON.stringify(payload)).not.toContain('secret');

    unwatch();
  });
});
