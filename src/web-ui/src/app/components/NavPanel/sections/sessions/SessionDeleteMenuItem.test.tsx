// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem } from '@openbitfun/ui';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ delete: vi.fn(), error: vi.fn(), confirm: vi.fn() }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  flowChatManager: { deleteChatSession: mocks.delete },
}));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {} }));
vi.mock('@/shared/notification-system', () => ({ notificationService: {} }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ error: mocks.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: mocks.confirm }));
vi.mock('@/infrastructure/i18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { useI18n: () => ({ t: createTestI18nT('common') }) };
});

import SessionDeleteMenuItem from './SessionDeleteMenuItem';
import { deleteSessionRow } from './sessionRowActions';

describe('session menu inline deletion confirmation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const description = 'This session and its child sessions will be permanently deleted.';
  const button = (action: string) => container.querySelector<HTMLButtonElement>(`[data-testid="delete${action ? `-${action}` : ''}"]`)!;
  const click = async (action = '') => { await act(async () => button(action).click()); };
  const render = async (open = true, sessionId = 'session-one') => {
    await act(async () => root.render(open ? (
      <Menu>
        <MenuItem>Archive</MenuItem>
        <SessionDeleteMenuItem
          sessionId={sessionId} label="Delete" description={description} testId="delete"
          onConfirm={() => deleteSessionRow(sessionId)}
        />
      </Menu>
    ) : null));
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetDeviceSurfaceForTest();
    mocks.delete.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDeviceSurfaceForTest();
    vi.unstubAllGlobals();
  });

  it('replaces only the delete row with Cancel and danger Confirm before deleting', async () => {
    await click();
    expect([...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Archive', 'Cancel', 'Confirm']);
    expect(button('confirm').closest('[data-openbitfun-tone]')?.getAttribute('data-openbitfun-tone')).toBe('danger');
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(description);
    expect(document.activeElement).toBe(button('cancel'));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await click('confirm');
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('session-one');
  });

  it('restores the delete row and focus when Cancel is selected', async () => {
    await click();
    await click('cancel');
    expect(button().textContent).toBe('Delete');
    expect(document.activeElement).toBe(button());
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('supports horizontal keyboard navigation and cancels with Escape', async () => {
    await click();
    await act(async () => button('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(button('confirm'));
    await act(async () => button('confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(button());
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('forgets pending confirmation when the menu closes', async () => {
    await click();
    await render(false);
    await render();
    expect(button().textContent).toBe('Delete');
    expect(button('confirm')).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('requires fresh confirmation when a retained menu targets another session', async () => {
    await click();
    await render(true, 'session-two');
    expect(button('confirm')).toBeNull();
    expect(button().dataset.sessionId).toBe('session-two');
    await render(true, 'session-one');
    expect(button('confirm')).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
    await click();
    await click('confirm');
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith('session-one');
  });

  it.each([false, true])('does not reuse confirmation after switching device (switch back: %s)', async switchBack => {
    await click();
    activateSurface('peer-one');
    if (switchBack) activateSurface('local');
    await click('confirm');
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(button().textContent).toBe('Delete');
  });

  it('disables confirmation while deletion is pending and does not submit twice', async () => {
    let finish!: () => void;
    mocks.delete.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await click();
    await click('confirm');
    expect(button('confirm').disabled).toBe(true);
    expect(button('cancel').disabled).toBe(true);
    await click('confirm');
    expect(mocks.delete).toHaveBeenCalledOnce();
    await act(async () => finish());
  });

  it('handles a failed deletion without retrying the mutation', async () => {
    const error = new Error('Host unavailable');
    mocks.delete.mockRejectedValueOnce(error);
    await click();
    await click('confirm');
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith('Failed to delete session', { sessionId: 'session-one', error });
  });
});
