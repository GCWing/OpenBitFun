// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionListPage, {
  captureSessionListOwnerEpoch,
} from '../../../../../mobile-web/src/pages/SessionListPage';
import type { RemoteSessionManager } from '../../../../../mobile-web/src/services/RemoteSessionManager';
import { useMobileStore } from '../../../../../mobile-web/src/services/store';

vi.mock('../../../../../mobile-web/src/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({
    language: 'en-US',
    toggleLanguage: vi.fn(),
    t,
    formatDate: () => '',
  }) };
});

vi.mock('../../../../../mobile-web/src/theme', () => ({
  useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

describe('SessionList target initialization ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useMobileStore.getState().resetConnectionState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not let an old timer closure borrow the mutable new owner epoch', () => {
    const manager = {
      controlTargetEpoch: 2,
    } as unknown as RemoteSessionManager;
    const mutableOwnerAfterRender = {
      sessionMgr: manager,
      epoch: 2,
      active: true,
    };

    expect(captureSessionListOwnerEpoch(
      mutableOwnerAfterRender,
      manager,
      1,
    )).toBeNull();
    expect(captureSessionListOwnerEpoch(
      mutableOwnerAfterRender,
      manager,
      2,
    )).toBe(2);
  });

  it('blocks A actions while B initializes and restores them only after B is ready', async () => {
    let epoch = 0;
    const targetListeners = new Set<() => void>();
    const deviceBInfo = deferred<any>();
    const getWorkspaceInfo = vi.fn()
      .mockResolvedValueOnce({
        resp: 'workspace_info',
        has_workspace: true,
        workspace_kind: 'assistant',
        path: '/assistant-a',
        project_name: 'Assistant A',
      })
      .mockImplementationOnce(() => deviceBInfo.promise);
    const listSessions = vi.fn().mockResolvedValue({
      resp: 'sessions',
      sessions: [],
      has_more: false,
    });
    const createSession = vi.fn().mockResolvedValue({
      session_id: 'session-b',
      workspace_id: 'assistant-b',
      workspace_path: '/assistant-b',
    });
    const manager = {
      get controlTargetEpoch() { return epoch; },
      onControlTargetChange: (listener: () => void) => {
        targetListeners.add(listener);
        return () => targetListeners.delete(listener);
      },
      getWorkspaceInfo,
      listSessions,
      listRecentWorkspaces: vi.fn().mockResolvedValue([]),
      listAssistants: vi.fn().mockResolvedValue([]),
      createSession,
      subscribeSessionStream: vi.fn().mockResolvedValue({ close: vi.fn() }),
    } as unknown as RemoteSessionManager;
    const onSelectSession = vi.fn();

    await act(async () => {
      root.render(
        <SessionListPage
          sessionMgr={manager}
          onSelectSession={onSelectSession}
          onOpenWorkspace={vi.fn()}
          onOpenDeviceTools={vi.fn()}
          onDisconnect={vi.fn()}
        />,
      );
    });
    await flushPromises();

    const initialSearch = container.querySelector<HTMLInputElement>('.session-list__search-input');
    expect(initialSearch?.disabled).toBe(false);
    expect(container.textContent).toContain('sessions.clawSession');

    await act(async () => {
      epoch = 1;
      for (const listener of targetListeners) listener();
    });

    const pendingSearch = container.querySelector<HTMLInputElement>('.session-list__search-input');
    expect(pendingSearch?.disabled).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('.session-list__mode-toggle-btn')]
        .every((button) => button.disabled),
    ).toBe(true);

    deviceBInfo.resolve({
      resp: 'workspace_info',
      has_workspace: true,
      workspace_kind: 'assistant',
      workspace_id: 'assistant-b',
      path: '/assistant-b',
      project_name: 'Assistant B',
    });
    await flushPromises();

    const readySearch = container.querySelector<HTMLInputElement>('.session-list__search-input');
    expect(readySearch?.disabled).toBe(false);
    const createClaw = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('sessions.clawSession'));
    expect(createClaw?.disabled).toBe(false);
    await act(async () => { createClaw?.click(); });
    await flushPromises();

    // The assistant workspace ID scopes the command; the path is the legacy projection.
    expect(createSession).toHaveBeenCalledWith(
      'claw',
      undefined,
      '/assistant-b',
      { workspaceId: 'assistant-b' },
    );
    expect(onSelectSession).toHaveBeenCalledWith(
      'session-b',
      'sessions.remoteClawSession',
      true,
      'claw',
    );
  });
  it('workspace creation offers all modes while footer tools preserve workspace identity', async () => {
    const selected = { path: '/same', name: 'Selected SSH', remote_connection_id: 'ssh-b', last_opened: '' };
    const createSession = vi.fn().mockResolvedValue('created-in-b');
    const manager = {
      controlTargetEpoch: 0,
      onControlTargetChange: () => () => {},
      subscribeSessionStream: vi.fn().mockResolvedValue({ close: vi.fn() }),
      supportsHostCapability: () => true,
      getWorkspaceInfo: vi.fn().mockResolvedValue({has_workspace: true, path: '/different', workspace_kind: 'normal'}),
      listWorkspaceCatalog: vi.fn().mockResolvedValue({workspaces: [selected], source: 'opened'}),
      listSessions: vi.fn().mockResolvedValue({sessions: [], has_more: false}),
      listAssistants: vi.fn().mockResolvedValue([]),
      listRecentWorkspaces: vi.fn().mockResolvedValue([selected]),
      createSession,
    } as unknown as RemoteSessionManager;
    const openTool = vi.fn();
    await act(async () => root.render(<SessionListPage compact sessionMgr={manager} client={{targetDeviceId: 'device-a', hasAccountIdentity: false} as any}
      onSelectSession={vi.fn()} onOpenWorkspace={vi.fn()} onOpenDeviceTools={openTool} onDisconnect={vi.fn()}/>));
    await flushPromises();
    await act(async () => container.querySelector<HTMLButtonElement>('.harmony-sidebar__workspace-tools')!.click());
    expect(createSession).not.toHaveBeenCalled();
    expect(openTool).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('shell.recentConversations');
    expect(container.querySelector('.harmony-sidebar__new-chat')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.harmony-sidebar__row-plus')!.click());
    const modes = [...document.querySelectorAll<HTMLButtonElement>('.harness-profile-picker [role="radio"]')];
    expect(modes).toHaveLength(3);
    await act(async () => modes[1].click());
    await flushPromises();
    expect(createSession).toHaveBeenCalledWith('Standard', undefined, '/same', {
      remoteConnectionId: 'ssh-b', remoteSshHost: undefined,
    });
  });

});
