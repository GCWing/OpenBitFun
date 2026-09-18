import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionFileModificationsBar } from './SessionFileModificationsBar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  files: [] as Array<{ filePath: string; sessionId: string }>,
  getSessionFiles: vi.fn(),
  getSessionFileDiffStats: vi.fn(),
  getOperationDiff: vi.fn(),
  flowState: {
    sessions: new Map<string, unknown>(),
  },
  listeners: new Set<(state: { sessions: Map<string, unknown> }) => void>(),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'sessionFileModificationsBar.filesCount') {
        return `${String(options?.count ?? 0)} files`;
      }
      return typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    },
  }),
}));

vi.mock('@openbitfun/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../tools/snapshot_system/hooks/useSnapshotState', () => ({
  useSnapshotState: () => ({
    files: mocks.files,
  }),
}));

vi.mock('../../../infrastructure/api', () => ({
  snapshotAPI: {
    getSessionFiles: mocks.getSessionFiles,
    getSessionFileDiffStats: mocks.getSessionFileDiffStats,
    getOperationDiff: mocks.getOperationDiff,
  },
}));

vi.mock('../../../infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({
    workspace: { id: 'workspace-1', workspaceKind: 'local', rootPath: 'D:/workspace/project' },
  }),
}));

// The session-driver registry pulls in the local driver and its runtime
// services; this bar only needs the session's workspace ID from it.
vi.mock('../../session-drivers/sessionFileNavigation', () => ({
  sessionWorkspaceId: (sessionId: string | undefined) => (sessionId === 'parent-session' ? 'workspace-1' : undefined),
}));

vi.mock('../../../shared/utils/tabUtils', () => ({
  createDiffEditorTab: vi.fn(),
}));

vi.mock('../../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => mocks.flowState,
    subscribe: (listener: (state: typeof mocks.flowState) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

describe('SessionFileModificationsBar', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

    mocks.files = [{
      filePath: 'src/current-session.ts',
      sessionId: 'parent-session',
    }];
    mocks.flowState.sessions = new Map<string, unknown>([
      ['parent-session', {
        sessionId: 'parent-session',
        sessionKind: 'normal',
        parentSessionId: undefined,
        lastActiveAt: 1,
      }],
      ['child-review-session', {
        sessionId: 'child-review-session',
        sessionKind: 'deep_review',
        parentSessionId: 'parent-session',
        lastActiveAt: 2,
      }],
    ]);
    mocks.listeners.clear();
    mocks.getSessionFiles.mockReset();
    mocks.getSessionFiles.mockResolvedValue(['src/child-review-only.ts']);
    mocks.getSessionFileDiffStats.mockReset();
    mocks.getSessionFileDiffStats.mockResolvedValue({
      linesAdded: 4,
      linesRemoved: 1,
      changeKind: 'modify',
    });
    mocks.getOperationDiff.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not include review child session files in the current chat file changes', async () => {
    await act(async () => {
      root.render(
        <SessionFileModificationsBar
          sessionId="parent-session"
          visible
        />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    expect(mocks.getSessionFiles).not.toHaveBeenCalledWith('child-review-session');
    // The owning session identifies the snapshot workspace (by ID, inside the
    // API); the current workspace path is not passed as a scope operand.
    expect(mocks.getSessionFileDiffStats).toHaveBeenCalledWith(
      'parent-session',
      'src/current-session.ts',
    );
    expect(mocks.getSessionFileDiffStats).not.toHaveBeenCalledWith(
      'child-review-session',
      'src/child-review-only.ts',
    );
    expect(container.textContent).toContain('1 files');
    expect(container.textContent).not.toContain('child-review-only.ts');
  });

  it('ignores stale async stats for files removed from the current session list', async () => {
    mocks.files = [
      { filePath: 'src/current-session.ts', sessionId: 'parent-session' },
      { filePath: 'src/stale-session.ts', sessionId: 'parent-session' },
    ];

    const pendingStats = new Map<string, ReturnType<typeof createDeferred<{
      linesAdded: number;
      linesRemoved: number;
      changeKind: 'modify';
    }>>>();

    mocks.getSessionFileDiffStats.mockImplementation((_sessionId: string, filePath: string) => {
      const deferred = createDeferred<{
        linesAdded: number;
        linesRemoved: number;
        changeKind: 'modify';
      }>();
      pendingStats.set(filePath, deferred);
      return deferred.promise;
    });

    await act(async () => {
      root.render(
        <SessionFileModificationsBar
          sessionId="parent-session"
          visible
        />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    expect(pendingStats.has('src/current-session.ts')).toBe(true);
    expect(pendingStats.has('src/stale-session.ts')).toBe(true);

    mocks.files = [
      { filePath: 'src/current-session.ts', sessionId: 'parent-session' },
    ];

    await act(async () => {
      root.render(
        <SessionFileModificationsBar
          sessionId="parent-session"
          visible
        />,
      );
    });

    await act(async () => {
      pendingStats.get('src/current-session.ts')?.resolve({
        linesAdded: 4,
        linesRemoved: 1,
        changeKind: 'modify',
      });
      pendingStats.get('src/stale-session.ts')?.resolve({
        linesAdded: 8,
        linesRemoved: 2,
        changeKind: 'modify',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('1 files');
    expect(container.textContent).not.toContain('stale-session.ts');
  });
});
