// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubagentProjectionView } from './SubagentProjectionView';
import type { FlowChatState, Session } from '../../types/flow-chat';

let flowChatState: FlowChatState;
const ensureBtwSessionAvailableMock = vi.fn();

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; shown?: number; total?: number }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock('../FlowTextBlock', () => ({
  FlowTextBlock: () => <div data-testid="flow-text-block" />,
}));

vi.mock('../../tool-cards/ModelThinkingDisplay', () => ({
  ModelThinkingDisplay: ({ sourceSessionId }: { sourceSessionId?: string }) => <div data-testid="thinking-display" data-source-session-id={sourceSessionId} />,
}));

vi.mock('../FlowToolCard', () => ({
  FlowToolCard: () => <div data-testid="flow-tool-card" />,
}));

vi.mock('../../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({
      getState: () => flowChatState,
      retainSessionHistory: () => () => {},
      subscribe: () => () => {},
    }),
  },
}));

vi.mock('../../services/btwSessionPane', () => ({
  ensureBtwSessionAvailable: (...args: unknown[]) => ensureBtwSessionAvailableMock(...args),
}));

function createSession(overrides: Partial<Session>): Session {
  return {
    sessionId: 'subagent-1',
    title: 'Subagent',
    dialogTurns: [],
    status: 'idle',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'subagent',
    ...overrides,
  } as Session;
}

describe('SubagentProjectionView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    ensureBtwSessionAvailableMock.mockReset();

    flowChatState = {
      sessions: new Map([
        ['parent-1', createSession({
          sessionId: 'parent-1',
          sessionKind: 'normal',
          workspacePath: 'D:/workspace/project',
          remoteConnectionId: 'remote-1',
          remoteSshHost: 'host-1',
        })],
      ]),
      activeSessionId: 'parent-1',
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hydrates a metadata-only historical subagent session when its detail panel is mounted', async () => {
    flowChatState.sessions.set('subagent-1', createSession({
      isHistorical: true,
      historyState: 'metadata-only',
      workspacePath: 'D:/workspace/project',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    }));

    await act(async () => {
      root.render(
        <SubagentProjectionView
          parentTaskToolId="task-1"
          parentSessionId="parent-1"
          subagentSessionId="subagent-1"
        />,
      );
      await Promise.resolve();
    });

    expect(ensureBtwSessionAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'subagent-1',
        parentSessionId: 'parent-1',
        workspacePath: 'D:/workspace/project',
        sessionKind: 'subagent',
        remoteConnectionId: 'remote-1',
        remoteSshHost: 'host-1',
        includeInternal: true,
      }),
    );
  });

  it('keeps projected thinking details owned by the child session', async () => {
    await act(async () => root.render(<SubagentProjectionView
      parentTaskToolId="task-1" parentSessionId="parent-1" sessionId="parent-1" subagentSessionId="subagent-1"
      items={[{ id: 'thinking-1', type: 'thinking', timestamp: 1, status: 'completed' }]}
    />));
    expect(container.querySelector('[data-testid="thinking-display"]')?.getAttribute('data-source-session-id')).toBe('subagent-1');
  });

  it('does not hydrate when the caller already supplies projected items', async () => {
    flowChatState.sessions.set('subagent-1', createSession({
      isHistorical: true,
      historyState: 'metadata-only',
      workspacePath: 'D:/workspace/project',
    }));

    await act(async () => {
      root.render(
        <SubagentProjectionView
          parentTaskToolId="task-1"
          parentSessionId="parent-1"
          subagentSessionId="subagent-1"
          items={[]}
        />,
      );
      await Promise.resolve();
    });

    expect(ensureBtwSessionAvailableMock).not.toHaveBeenCalled();
  });
});
