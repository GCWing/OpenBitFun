// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '@openbitfun/ui';
import type { FlowChatState, Session } from '@/flow_chat/types/flow-chat';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), delete: vi.fn(), refresh: vi.fn(), confirm: vi.fn(),
  success: vi.fn(), warning: vi.fn(), error: vi.fn(), close: vi.fn(), changed: vi.fn(),
  state: { sessions: new Map(), activeSessionId: 'another-session' } as FlowChatState,
}));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  flowChatManager: { deleteChatSession: mocks.delete, refreshWorkspaceSessions: mocks.refresh },
}));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { unarchiveSession: mocks.restore } }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: { setState: (updater: (state: FlowChatState) => FlowChatState) => { mocks.state = updater(mocks.state); } },
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: mocks.confirm }));
vi.mock('@/shared/notification-system', () => ({ notificationService: mocks }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/infrastructure/i18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { useI18n: () => ({ t: createTestI18nT('common') }) };
});
import ArchivedSessionMenuItems from './ArchivedSessionMenuItems';

describe('archived session row menu', () => {
  let root: Root;
  let container: HTMLDivElement;
  const session = {
    sessionId: 'archived-one', workspaceId: 'owning-workspace',
    projectWorkspaceId: 'display-project', persistedStatus: 'archived', config: {},
  } as Session;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetDeviceSurfaceForTest();
    mocks.state = { sessions: new Map([[session.sessionId, session]]), activeSessionId: 'another-session' } as FlowChatState;
    mocks.restore.mockResolvedValue(undefined);
    mocks.delete.mockResolvedValue(undefined);
    mocks.refresh.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async (overrides: Partial<Session> = {}) => {
    await act(async () => root.render(
      <Menu>
        <ArchivedSessionMenuItems
          session={{ ...session, ...overrides }} title="Archived chat" workspaceName="Project"
          onClose={mocks.close} onChanged={mocks.changed}
        />
      </Menu>,
    ));
  };
  const click = async (action: 'restore' | 'delete-archived') => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="nav-session-menu-${action}"]`)!.click());
  };

  it('offers exactly Restore and Delete for native and external archived sessions', async () => {
    for (const overrides of [{}, { externalHistory: { mode: 'follow' as const }, importedSource: 'codex' as const }]) {
      await render(overrides);
      expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Restore', 'Delete']);
    }
  });

  it('restores immediately using the owning workspace and refreshes navigation', async () => {
    await render();
    await click('restore');
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith('archived-one', 'owning-workspace');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({ id: 'owning-workspace' });
    expect(mocks.state.sessions.get(session.sessionId)?.persistedStatus).toBe('active');
    expect(mocks.state.activeSessionId).toBe('another-session');
    expect(mocks.changed).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('retains the successful restore when refreshing fails without repeating the mutation', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('Offline'));
    await render();
    await click('restore');
    expect(mocks.restore).toHaveBeenCalledOnce();
    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(mocks.state.sessions.get(session.sessionId)?.persistedStatus).toBe('active');
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.changed).toHaveBeenCalledOnce();
  });

  it('confirms permanent deletion and preserves the record when cancelled', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await render();
    await click('delete-archived');
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.changed).not.toHaveBeenCalled();
    expect(mocks.state.sessions.get(session.sessionId)?.persistedStatus).toBe('archived');
    await click('delete-archived');
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      'Delete Archived Session', expect.stringContaining('Archived chat'), { confirmText: 'Delete' },
    );
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('archived-one');
    expect(mocks.changed).toHaveBeenCalledOnce();
  });

  it('keeps a failed restore available for retry', async () => {
    mocks.restore.mockRejectedValueOnce(new Error('Offline'));
    await render();
    await click('restore');
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.changed).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="nav-session-menu-restore"]')!.disabled).toBe(false);
  });

  it('does not delete on another device if the surface changes while confirmation is open', async () => {
    let confirm!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { confirm = resolve; }));
    await render();
    await click('delete-archived');
    activateSurface('peer-one');
    await act(async () => confirm(true));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.changed).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
