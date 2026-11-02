// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ discard: vi.fn(), save: vi.fn(), canSave: vi.fn(), error: vi.fn(), sessions: new Map<string, any>() }));
vi.mock('@/flow_chat/services/BtwSessionLifecycle', () => ({ discardBtwSession: state.discard, saveBtwSessionAsFork: state.save, canSaveBtwSessionAsFork: state.canSave }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: state.sessions }) } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: state.error } }));
vi.mock('@/shared/services/workbenchContentService', () => ({ openCanvasContent: vi.fn(), openContentInBestTarget: vi.fn() }));
vi.mock('@/shared/services/pendingTabQueue', () => ({ drainPendingTabs: () => [] }));
vi.mock('@/shared/services/destroyTerminalSession', () => ({ destroyTerminalSession: vi.fn() }));

import { useTabLifecycle } from './useTabLifecycle';
import { CanvasStoreModeContext, clearAgentCanvasForPeerSwitch, switchAgentCanvasScope, useAgentCanvasStore } from '../stores';
import { useConfirmDialogStore } from '@/infrastructure/confirm-dialog/confirmDialogService';

describe('BTW tab close transitions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let lifecycle: ReturnType<typeof useTabLifecycle>;
  const addBtw = (id: string, pinned = false) => {
    state.sessions.set(id, { sessionKind: 'btw', submitted: true });
    useAgentCanvasStore.getState().addTab({
      type: 'btw-session', title: id, data: { childSessionId: id, parentSessionId: 'parent' },
      metadata: { discardSessionOnClose: true },
    }, pinned ? 'pinned' : 'active', 'primary');
    return useAgentCanvasStore.getState().primaryGroup.tabs.at(-1)!.id;
  };
  const beginClose = async (close: () => Promise<boolean>) => {
    let pending!: Promise<boolean>;
    await act(async () => { pending = close(); });
    return { pending };
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    state.sessions.clear();
    state.discard.mockResolvedValue(undefined);
    state.save.mockResolvedValue(undefined);
    state.canSave.mockImplementation((id: string) => state.sessions.get(id)?.submitted === true);
    clearAgentCanvasForPeerSwitch();
    useAgentCanvasStore.getState().reset();
    switchAgentCanvasScope('parent');
    container = document.createElement('div');
    root = createRoot(container);
    function Probe() { lifecycle = useTabLifecycle(); return null; }
    await act(async () => root.render(<CanvasStoreModeContext.Provider value="agent"><Probe /></CanvasStoreModeContext.Provider>));
  });
  afterEach(async () => {
    useConfirmDialogStore.getState().cancel();
    await act(async () => root.unmount());
    clearAgentCanvasForPeerSwitch();
    container.remove();
  });

  it('keeps the conversation and tab when the shared confirmation is cancelled', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    expect(useConfirmDialogStore.getState().options).toMatchObject({
      title: 'tabs.closeBtwTitle', confirmText: 'tabs.close', cancelText: 'dialog.confirm.cancel', confirmDanger: true,
      secondaryText: 'tabs.saveBtwAsFork',
      secondaryActionPlacement: 'start',
    });
    useConfirmDialogStore.getState().cancel();
    expect(await pending).toBe(false);
    expect(state.discard).not.toHaveBeenCalled();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toContain(id);
  });

  it('saves and closes through the shared secondary action', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    await act(async () => { useConfirmDialogStore.getState().secondary(); expect(await pending).toBe(true); });
    expect(state.save).toHaveBeenCalledWith('child');
    expect(state.discard).not.toHaveBeenCalled();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useAgentCanvasStore.getState().closedTabs).toEqual([]);
  });

  it('keeps the tab when saving fails', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    state.save.mockRejectedValueOnce(new Error('host offline'));
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    await act(async () => { useConfirmDialogStore.getState().secondary(); expect(await pending).toBe(false); });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toContain(id);
    expect(state.error).toHaveBeenCalledWith('tabs.saveBtwFailed');
  });

  it('keeps empty drafts limited to cancel and close', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); state.sessions.get('child').submitted = false; });
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    expect(useConfirmDialogStore.getState().options?.secondaryText).toBeUndefined();
    useConfirmDialogStore.getState().cancel();
    expect(await pending).toBe(false);
  });

  it('saves submitted conversations during bulk closure and discards only empty drafts', async () => {
    await act(async () => {
      addBtw('child'); addBtw('empty'); addBtw('pinned', true);
      state.sessions.get('empty').submitted = false;
    });
    const { pending } = await beginClose(() => lifecycle.handleCloseAllWithDirtyCheck('primary'));
    await act(async () => { useConfirmDialogStore.getState().secondary(); expect(await pending).toBe(true); });
    expect(state.save).toHaveBeenCalledWith('child');
    expect(state.discard).toHaveBeenCalledWith('empty');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.title)).toEqual(['pinned']);
  });

  it('discards only after confirmation and excludes the tab from reopen history', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    expect(state.discard).not.toHaveBeenCalled();
    await act(async () => { useConfirmDialogStore.getState().confirm(); expect(await pending).toBe(true); });
    expect(state.discard).toHaveBeenCalledWith('child');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useAgentCanvasStore.getState().closedTabs).toEqual([]);
  });

  it('keeps the tab and reports cleanup failure', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    state.discard.mockRejectedValueOnce(new Error('host offline'));
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    await act(async () => { useConfirmDialogStore.getState().confirm(); expect(await pending).toBe(false); });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toContain(id);
    expect(state.error).toHaveBeenCalledWith('tabs.closeBtwFailed');
  });

  it('confirms bulk closure once, preserves pinned tabs, and leaves review lifetime independent', async () => {
    await act(async () => {
      addBtw('child-a'); addBtw('child-b'); addBtw('pinned-child', true);
      state.sessions.set('review', { sessionKind: 'review' });
      useAgentCanvasStore.getState().addTab({ type: 'btw-session', title: 'review', data: { childSessionId: 'review' } }, 'active');
    });
    const { pending } = await beginClose(() => lifecycle.handleCloseAllWithDirtyCheck('primary'));
    expect(useConfirmDialogStore.getState().options?.message).toBe('tabs.confirmCloseBtw');
    await act(async () => { useConfirmDialogStore.getState().confirm(); expect(await pending).toBe(true); });
    expect(state.discard.mock.calls.map(call => call[0]).sort()).toEqual(['child-a', 'child-b']);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.title)).toEqual(['pinned-child']);
    expect(useAgentCanvasStore.getState().closedTabs.map(record => record.tab.title)).toEqual(['review']);
  });

  it('does not discard another canvas after the source scope changes during confirmation', async () => {
    let id!: string;
    await act(async () => { id = addBtw('child'); });
    const { pending } = await beginClose(() => lifecycle.handleCloseWithDirtyCheck(id, 'primary'));
    await act(async () => { switchAgentCanvasScope('other-parent'); useConfirmDialogStore.getState().confirm(); });
    expect(await pending).toBe(false);
    expect(state.discard).not.toHaveBeenCalled();
    await act(async () => switchAgentCanvasScope('parent'));
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toContain(id);
  });
});
