// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceSessionBatchModal from './WorkspaceSessionBatchModal';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(), archiveChatSession: vi.fn(), deleteChatSession: vi.fn(),
  refreshWorkspaceSessions: vi.fn(), confirmWarning: vi.fn(), confirmDanger: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: mocks }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: mocks }));
vi.mock('@/infrastructure/confirm-dialog', () => mocks);
vi.mock('@/shared/notification-system', () => ({
  notificationService: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatDate: () => '', formatRelativeTime: () => '' }),
}));
vi.mock('@openbitfun/ui', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Box, DialogBody: Box, DialogHeader: Box, DialogHeading: Box,
    DialogTitle: Box, DialogDescription: Box, DialogFooter: Box, ScrollArea: Box,
    DialogClose: () => null, Icon: () => null, Spinner: () => null, OverflowText: Box,
    Button: ({ children, onClick, disabled }: React.ComponentProps<'button'>) => (
      <button onClick={onClick} disabled={disabled}>{children}</button>
    ),
    Checkbox: ({ label, checked, onChange, disabled }: React.ComponentProps<'input'> & { label: React.ReactNode }) => (
      <label><input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />{label}</label>
    ),
  };
});

describe('Claw session batch management', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDanger.mockResolvedValue(true);
    mocks.listSessions.mockResolvedValue([
      { sessionId: 'claw-1', sessionName: 'First assistant chat', agentType: 'Claw', workspacePath: '/assistant', remoteConnectionId: 'ssh-one', workspaceId: 'assistant-one', status: 'idle', createdAt: 1, lastActiveAt: 1 },
      { sessionId: 'claw-2', sessionName: 'Second assistant chat', agentType: 'Claw', workspacePath: '/assistant', remoteConnectionId: 'ssh-one', workspaceId: 'assistant-one', status: 'idle', createdAt: 2, lastActiveAt: 2 },
      { sessionId: 'other-host', sessionName: 'Other host', agentType: 'Claw', workspacePath: '/assistant', remoteConnectionId: 'ssh-two', workspaceId: 'assistant-two', status: 'idle' },
      { sessionId: 'archived', sessionName: 'Archived chat', agentType: 'Claw', workspacePath: '/assistant', remoteConnectionId: 'ssh-one', workspaceId: 'assistant-one', status: 'archived' },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function renderAndSelectAll() {
    await act(async () => root.render(
      <WorkspaceSessionBatchModal workspaceId="assistant-one" isOpen onClose={() => {}} workspaceLabel="Claw" />,
    ));
    expect(mocks.listSessions).toHaveBeenCalledWith('assistant-one');
    expect(container.textContent).toContain('First assistant chat');
    expect(container.textContent).toContain('Second assistant chat');
    expect(container.textContent).not.toContain('Other host');
    expect(container.textContent).not.toContain('Archived chat');
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  }
  async function clickAction(key: string) {
    const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === key);
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
  }

  it('archives selected Claw sessions immediately within the chosen host', async () => {
    await renderAndSelectAll();
    await clickAction('nav.sessions.archiveSelected');
    expect(mocks.confirmWarning).not.toHaveBeenCalled();
    expect(mocks.confirmDanger).not.toHaveBeenCalled();
    expect(mocks.archiveChatSession.mock.calls).toEqual([['claw-2'], ['claw-1']]);
    expect(mocks.refreshWorkspaceSessions).toHaveBeenCalledWith({ id: 'assistant-one' });
  });

  it('deletes selected Claw sessions after explicit confirmation', async () => {
    await renderAndSelectAll();
    await clickAction('nav.sessions.deleteSelected');
    expect(mocks.confirmDanger).toHaveBeenCalledTimes(1);
    expect(mocks.deleteChatSession.mock.calls).toEqual([['claw-2'], ['claw-1']]);
  });
});
