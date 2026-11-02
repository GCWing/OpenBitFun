// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), prepare: vi.fn(), error: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./assistantSessionPreferences', () => ({ readAssistantDefaultSession: mocks.read, saveAssistantDefaultSession: mocks.save }));
vi.mock('@/flow_chat/services/sessionDraftService', () => ({ prepareSessionDraftForCommand: mocks.prepare }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: { getState: () => ({ sessions: new Map([['chosen', {
    sessionId: 'chosen', workspaceId: 'assistant', config: {},
  }]]) }) },
}));
vi.mock('../sessions/SessionsSection', () => ({
  default: ({ defaultSessionAction: action, onSessionOpened, useWorkspaceViewPreferences }: {
    defaultSessionAction: { sessionId: string | null; disabled: boolean; onChange: (id: string) => void };
    onSessionOpened?: () => void;
    useWorkspaceViewPreferences?: boolean;
  }) => <>
    <span data-default={action.sessionId ?? ''} data-shared-filters={useWorkspaceViewPreferences} />
    <button data-set-default disabled={action.disabled} onClick={() => action.onChange('chosen')}>Pin</button>
    <button data-open-session onClick={onSessionOpened}>Open</button>
  </>,
}));
vi.mock('@openbitfun/ui', () => {
  return {
    Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button disabled={disabled} onClick={onClick}>{children}</button>
    ),
  };
});

import AssistantSessionHistory from './AssistantSessionHistory';

describe('assistant history default selection', () => {
  let root: Root;
  let container: HTMLDivElement;
  const workspace = { id: 'assistant', name: 'Assistant', rootPath: '/assistant', workspaceKind: 'assistant' } as WorkspaceInfo;
  const render = async () => {
    await act(async () => root.render(<AssistantSessionHistory workspace={workspace} isActive />));
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue({ supported: true, sessionId: 'previous' });
    mocks.save.mockResolvedValue(undefined);
    mocks.prepare.mockResolvedValue(undefined);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); });

  it('persists the selected session after preparing its draft, and allows clearing the default', async () => {
    await render();
    expect(container.querySelector('[data-default]')?.getAttribute('data-default')).toBe('previous');
    expect(container.querySelector('[data-shared-filters]')?.getAttribute('data-shared-filters')).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-set-default]')!.click());
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith('assistant', 'chosen');
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]);
    expect(container.querySelector('[data-default]')?.getAttribute('data-default')).toBe('chosen');
    const clear = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'nav.sessions.clearDefault')!;
    await act(async () => clear.click());
    expect(mocks.save).toHaveBeenLastCalledWith('assistant', null);
    expect(container.querySelector('[data-default]')?.getAttribute('data-default')).toBe('');
  });

  it('retains the previous default if saving fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Host offline'));
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-set-default]')!.click());
    expect(container.querySelector('[data-default]')?.getAttribute('data-default')).toBe('previous');
    expect(mocks.error).toHaveBeenCalledWith('Host offline');
  });

  it('disables default selection on an old host while allowing history navigation', async () => {
    mocks.read.mockResolvedValue({ supported: false, sessionId: null });
    await render();
    expect(container.querySelector<HTMLButtonElement>('[data-set-default]')!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-open-session]')!.click());
    expect(container.querySelector('[data-open-session]')).not.toBeNull();
    expect(container.querySelector('[data-set-default]')).not.toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
