// @vitest-environment jsdom
import React, { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantBootstrap } from './useAssistantBootstrap';
import { sessionComposerStore } from '@/flow_chat/store/sessionComposerStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const { readWorkspaceFile, submit, t } = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  submit: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { readWorkspaceFile },
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { ensureAssistantBootstrap: submit, startDialogTurn: submit },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t }) }));

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'claw-1', mode: 'Claw', workspaceId: 'assistant-default', workspacePath: '/assistants/default',
    config: {}, dialogTurns: [], status: 'idle', title: 'Claw',
    createdAt: 1, lastActiveAt: 1, error: null,
    ...overrides,
  } as Session;
}

function Composer({ target }: { target: Session }) {
  const onDraftReady = useCallback((value: string) => {
    sessionComposerStore.getState().setValue(target.sessionId, value);
  }, [target.sessionId]);
  useAssistantBootstrap(target, onDraftReady);
  return null;
}

describe('assistant bootstrap draft', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    resetDeviceSurfaceForTest();
    sessionComposerStore.setState({ drafts: {} });
    vi.clearAllMocks();
    readWorkspaceFile.mockResolvedValue('# Bootstrap');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDeviceSurfaceForTest();
  });
  const render = async (target = session()) => {
    await act(async () => root.render(<Composer target={target} />));
  };

  it('prefills an empty Claw composer without starting a turn', async () => {
    await render();
    expect(readWorkspaceFile).toHaveBeenCalledWith('assistant-default', '/assistants/default/BOOTSTRAP.md');
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('nav.sessions.assistantBootstrapDraft');
    expect(submit).not.toHaveBeenCalled();
  });

  it('leaves initialized assistants and existing conversations alone', async () => {
    readWorkspaceFile.mockRejectedValueOnce(new Error('No such file'));
    await render();
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
    readWorkspaceFile.mockClear();
    await render(session({ sessionId: 'existing', totalTurnCount: 3 }));
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    await render(session({ sessionId: 'code', mode: 'Standard' }));
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('does not replace a user draft or restore an explicitly cleared template', async () => {
    sessionComposerStore.getState().setValue('claw-1', 'My own request');
    await render();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    sessionComposerStore.getState().clearDraft('claw-1');
    await render(session({ sessionId: 'other', mode: 'Standard' }));
    await render();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
  });

  it('preserves typing while the bootstrap check is in flight', async () => {
    let finish!: (content: string) => void;
    readWorkspaceFile.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    await render();
    sessionComposerStore.getState().setValue('claw-1', 'Already typing');
    await act(async () => finish('# Bootstrap'));
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('Already typing');
  });

  it('does not refill or restart initialization after the user stops the submitted turn', async () => {
    await render();
    sessionComposerStore.getState().clearDraft('claw-1');
    await render(session({
      lastSubmittedMode: 'Claw',
      dialogTurns: [{
        id: 'bootstrap-turn', sessionId: 'claw-1', status: 'cancelled', startTime: 1,
        userMessage: { id: 'user-1', content: 'Initialize', timestamp: 1 }, modelRounds: [],
      }],
    }));
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
    expect(submit).not.toHaveBeenCalled();
  });

  it('discards a late result after changing sessions', async () => {
    let finish!: (content: string) => void;
    readWorkspaceFile.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    await render();
    await render(session({ sessionId: 'other', mode: 'Standard' }));
    await act(async () => finish('# Bootstrap'));
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
    expect(sessionComposerStore.getState().getDraft('other').value).toBe('');
  });

  it('routes remote workspace reads through the owning workspace ID and never falls back to a local file', async () => {
    readWorkspaceFile.mockRejectedValueOnce(new Error('Remote host is offline'));
    await render(session({
      workspaceId: 'remote-assistant', remoteConnectionId: 'ssh-host', workspacePath: '/home/user/assistant/',
    }));
    expect(readWorkspaceFile).toHaveBeenCalledExactlyOnceWith('remote-assistant', '/home/user/assistant/BOOTSTRAP.md');
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
  });

  it('does not read anything for a session without a workspace ID', async () => {
    await render(session({ workspaceId: undefined }));
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
  });

  it('rejects a late peer result even when the new surface has the same session id', async () => {
    let finish!: (content: string) => void;
    readWorkspaceFile.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    await render();
    activateSurface('peer:other');
    await act(async () => finish('# Bootstrap'));
    expect(sessionComposerStore.getState().getDraft('claw-1').value).toBe('');
  });
});
