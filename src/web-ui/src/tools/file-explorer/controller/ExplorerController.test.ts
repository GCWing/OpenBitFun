import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerController } from './ExplorerController';
import type { ExplorerFileSystemProvider } from '../types/explorer';

const startupTraceMock = vi.hoisted(() => ({
  markPhase: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/shared/utils/startupTrace', () => ({
  startupTrace: startupTraceMock,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => loggerMock,
}));

describe('ExplorerController startup observability', () => {
  it('reloads the same POSIX root for another workspace ID and discards the old read', async () => {
    // Two SSH workspaces can share one POSIX root; only the workspace ID tells them apart.
    let finishOld!: (nodes: Awaited<ReturnType<ExplorerFileSystemProvider['getChildren']>>) => void;
    const provider: ExplorerFileSystemProvider = {
      getChildren: vi.fn(request => request.workspaceId === 'workspace-ssh-a'
        ? new Promise(resolve => { finishOld = resolve; })
        : Promise.resolve([{ path: '/repo/b.txt', name: 'b.txt', isDirectory: false }])),
      watch: vi.fn(() => () => {}),
    };
    const controller = new ExplorerController(provider);
    try {
      const old = controller.configure({ rootPath: '/repo', workspaceId: 'workspace-ssh-a', enableAutoWatch: false });
      await controller.configure({ rootPath: '/repo', workspaceId: 'workspace-ssh-b', enableAutoWatch: false });
      finishOld([{ path: '/repo/a.txt', name: 'a.txt', isDirectory: false }]);
      await old;
      expect(provider.getChildren).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/repo', workspaceId: 'workspace-ssh-b' }));
      expect(JSON.stringify(controller.getSnapshot().fileTree)).toContain('b.txt');
      expect(JSON.stringify(controller.getSnapshot().fileTree)).not.toContain('a.txt');
    } finally {
      controller.dispose();
    }
  });
  beforeEach(() => {
    startupTraceMock.markPhase.mockClear();
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  it('records sanitized root load timing without exposing the workspace path', async () => {
    const provider: ExplorerFileSystemProvider = {
      getChildren: vi.fn(async () => [
        { path: 'C:\\secret\\repo\\src', name: 'src', isDirectory: true },
      ]),
      watch: vi.fn(() => () => {}),
    };
    const controller = new ExplorerController(provider);

    await controller.configure({
      rootPath: 'C:\\secret\\repo',
      autoLoad: true,
      enableAutoWatch: false,
    });

    expect(startupTraceMock.markPhase).toHaveBeenCalledWith(
      'file_explorer_root_load_start',
      expect.objectContaining({
        generation: 1,
        autoLoad: true,
        enableAutoWatch: false,
      })
    );
    expect(startupTraceMock.markPhase).toHaveBeenCalledWith(
      'file_explorer_directory_resolve_start',
      expect.objectContaining({
        isRoot: true,
        generation: 1,
        forceRefresh: true,
      })
    );
    expect(startupTraceMock.markPhase).toHaveBeenCalledWith(
      'file_explorer_root_load_end',
      expect.objectContaining({
        generation: 1,
        durationMs: expect.any(Number),
        childCount: 1,
      })
    );

    const serializedTracePayloads = JSON.stringify(startupTraceMock.markPhase.mock.calls);
    expect(serializedTracePayloads).not.toContain('C:\\secret\\repo');
  });

  it('does not recursively watch the whole workspace on root mount', async () => {
    const provider: ExplorerFileSystemProvider = {
      getChildren: vi.fn(async () => [
        { path: 'C:\\large\\repo\\src', name: 'src', isDirectory: true },
      ]),
      watch: vi.fn(() => () => {}),
    };
    const controller = new ExplorerController(provider);

    await controller.configure({
      rootPath: 'C:\\large\\repo',
      autoLoad: true,
      enableAutoWatch: true,
    });

    expect(provider.watch).toHaveBeenCalledWith(
      'C:\\large\\repo',
      expect.any(Function),
      expect.objectContaining({ recursive: false })
    );
  });

  it('watches only visible expanded directories without recursive workspace watching', async () => {
    const provider: ExplorerFileSystemProvider = {
      getChildren: vi.fn(async ({ path }) => {
        if (path === 'C:\\large\\repo') {
          return [{ path: 'C:\\large\\repo\\src', name: 'src', isDirectory: true }];
        }
        if (path === 'C:\\large\\repo\\src') {
          return [{ path: 'C:\\large\\repo\\src\\index.ts', name: 'index.ts', isDirectory: false }];
        }
        return [];
      }),
      watch: vi.fn(() => () => {}),
    };
    const controller = new ExplorerController(provider);

    await controller.configure({
      rootPath: 'C:\\large\\repo',
      autoLoad: true,
      enableAutoWatch: true,
    });
    vi.mocked(provider.watch).mockClear();

    await controller.expandFolderLazy('C:\\large\\repo\\src');

    expect(provider.watch).toHaveBeenCalledWith(
      'C:\\large\\repo\\src',
      expect.any(Function),
      expect.objectContaining({ recursive: false })
    );
    expect(provider.watch).not.toHaveBeenCalledWith(
      'C:\\large\\repo',
      expect.any(Function),
      expect.any(Object)
    );
    expect(provider.watch).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ recursive: true })
    );
  });

  it('updates visible directory watches incrementally without restarting unchanged roots', async () => {
    const unwatchRoot = vi.fn();
    const unwatchSrc = vi.fn();
    const provider: ExplorerFileSystemProvider = {
      getChildren: vi.fn(async ({ path }) => {
        if (path === 'C:\\large\\repo') {
          return [{ path: 'C:\\large\\repo\\src', name: 'src', isDirectory: true }];
        }
        if (path === 'C:\\large\\repo\\src') {
          return [{ path: 'C:\\large\\repo\\src\\index.ts', name: 'index.ts', isDirectory: false }];
        }
        return [];
      }),
      watch: vi.fn((path) => (path === 'C:\\large\\repo\\src' ? unwatchSrc : unwatchRoot)),
    };
    const controller = new ExplorerController(provider);

    await controller.configure({
      rootPath: 'C:\\large\\repo',
      autoLoad: true,
      enableAutoWatch: true,
    });
    expect(provider.watch).toHaveBeenCalledTimes(1);
    expect(provider.watch).toHaveBeenCalledWith(
      'C:\\large\\repo',
      expect.any(Function),
      expect.objectContaining({ recursive: false })
    );

    vi.mocked(provider.watch).mockClear();
    await controller.expandFolderLazy('C:\\large\\repo\\src');

    expect(unwatchRoot).not.toHaveBeenCalled();
    expect(provider.watch).toHaveBeenCalledTimes(1);
    expect(provider.watch).toHaveBeenCalledWith(
      'C:\\large\\repo\\src',
      expect.any(Function),
      expect.objectContaining({ recursive: false })
    );

    vi.mocked(provider.watch).mockClear();
    await controller.expandFolderLazy('C:\\large\\repo\\src');

    expect(unwatchRoot).not.toHaveBeenCalled();
    expect(unwatchSrc).toHaveBeenCalledTimes(1);
    expect(provider.watch).not.toHaveBeenCalled();
  });
});
