import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import {
  getSubagentAvatarDefinition,
  resolveSubagentAvatarPresentation,
} from '../subagent-identity';
import { AgentControlToolCard } from './AgentControlToolCard';

const mocks = vi.hoisted(() => ({
  openBtwSessionInAuxPane: vi.fn(),
  listeners: new Set<() => void>(),
  includeChildSession: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'flowChatHeader.agentTreeStatus.running') return 'Running';
      if (key === 'flowChatHeader.agentTreeStatus.completed') return 'Completed';
      if (key === 'toolCards.taskTool.defaultAgentKind') return 'Agent';
      if (typeof options?.defaultValue === 'string') return options.defaultValue;
      return key;
    },
  }),
}));

vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../services/btwSessionPane', () => ({
  openBtwSessionInAuxPane: (...args: unknown[]) => mocks.openBtwSessionInAuxPane(...args),
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    getState: () => {
      const sessions = new Map<string, any>([
        ['parent-session', {
          sessionId: 'parent-session',
          workspacePath: 'D:\\workspace\\repo',
          remoteConnectionId: 'remote-1',
          remoteSshHost: 'host-1',
          config: { agentType: 'Ultimate' },
          dialogTurns: [],
        }],
      ]);
      if (mocks.includeChildSession) {
        sessions.set('child-session', {
          sessionId: 'child-session',
          sessionKind: 'subagent',
          parentSessionId: 'parent-session',
          parentToolCallId: 'agent-call',
          subagentType: 'SwarmWorker',
          mode: 'SwarmWorker',
          title: 'SwarmWorker: inspect parser',
          createdAt: 1000,
          status: 'active',
          config: { agentType: 'SwarmWorker' },
          dialogTurns: [{
            id: 'child-turn',
            status: 'processing',
            modelRounds: [],
          }],
        });
      }
      return { sessions };
    },
  },
}));

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

const config: ToolCardConfig = {
  toolName: 'AgentSpawn',
  displayName: 'Launch Agent',
  icon: '',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
};

function agentToolItem(
  toolName: 'AgentSpawn' | 'AgentSendInput',
  overrides: Partial<FlowToolItem> = {},
): FlowToolItem {
  return {
    id: 'agent-tool',
    type: 'tool',
    toolName,
    timestamp: Date.now(),
    status: 'completed',
    subagentSessionId: 'child-session',
    subagentDialogTurnId: 'child-turn',
    toolCall: {
      id: 'agent-call',
      input: toolName === 'AgentSpawn'
        ? {
            agent_id: 'parser_review-worker_2',
            agent_type: 'SwarmWorker',
            prompt: 'Inspect the parser flow and report findings.',
          }
        : {
            agent_id: 'agent-1',
            prompt: 'Continue with the error recovery paths.',
          },
    },
    ...overrides,
  };
}

describeWithJsdom('AgentControlToolCard', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });
    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('CustomEvent', window.CustomEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    mocks.includeChildSession = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    dom.window.close();
    mocks.listeners.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['AgentSpawn', 'AgentSendInput'] as const)(
    'shares the design-system agent summary, status, and expandable prompt for %s',
    async (toolName) => {
      await act(async () => {
        root.render(
          <AgentControlToolCard
            toolItem={agentToolItem(toolName)}
            config={{ ...config, toolName }}
            sessionId="parent-session"
          />,
        );
      });

      const card = container.querySelector<HTMLElement>('[data-openbitfun-tool-card="agent-control"]');
      const identity = card?.querySelector<HTMLElement>('[data-openbitfun-part="agentIdentity"]');
      const openButton = card?.querySelector<HTMLButtonElement>('[data-openbitfun-part="openAgentButton"]');
      const toggle = card?.querySelector<HTMLElement>('[data-openbitfun-part="surface"]');
      expect(card?.getAttribute('data-openbitfun-attention')).toBe('prominent');
      expect(identity?.textContent?.trim()).toBeTruthy();
      expect(identity?.textContent).toContain(
        toolName === 'AgentSpawn' ? 'Parser review worker 2' : 'Agent 1',
      );
      expect(identity?.textContent).not.toContain(
        toolName === 'AgentSpawn' ? 'parser_review-worker_2' : 'agent-1',
      );
      expect(card?.querySelector('[data-openbitfun-part="avatar"] [data-openbitfun-component="subagent-avatar"]')).not.toBeNull();
      expect(container.querySelector('[data-openbitfun-part="type"]')).toBeNull();
      expect(container.textContent).not.toContain('SwarmWorker');
      expect(container.textContent).toContain('Running');
      expect(card?.querySelector('[data-openbitfun-part="affordanceButton"]')).not.toBeNull();
      expect(card?.querySelector('[data-openbitfun-part="processing"]')).not.toBeNull();
      expect(container.textContent).not.toContain(
        toolName === 'AgentSpawn'
          ? 'Inspect the parser flow and report findings.'
          : 'Continue with the error recovery paths.',
      );

      await act(async () => {
        toggle!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      expect(container.textContent).toContain(
        toolName === 'AgentSpawn'
          ? 'Inspect the parser flow and report findings.'
          : 'Continue with the error recovery paths.',
      );

      await act(async () => {
        openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
        childSessionId: 'child-session',
        parentSessionId: 'parent-session',
        parentToolCallId: 'agent-call',
        sessionKind: 'subagent',
        sessionTitle: toolName === 'AgentSpawn' ? 'Parser review worker 2' : 'Agent 1',
        includeInternal: true,
      }));
      expect(container.textContent).toContain(
        toolName === 'AgentSpawn'
          ? 'Inspect the parser flow and report findings.'
          : 'Continue with the error recovery paths.',
      );
    },
  );

  it('renders the session-mapped avatar before the restored child session is loaded', async () => {
    mocks.includeChildSession = false;

    await act(async () => {
      root.render(
        <AgentControlToolCard
          toolItem={agentToolItem('AgentSendInput')}
          config={{ ...config, toolName: 'AgentSendInput' }}
          sessionId="parent-session"
        />,
      );
    });

    const avatar = container.querySelector('[data-openbitfun-component="subagent-avatar"]');
    const presentation = resolveSubagentAvatarPresentation('child-session');
    expect(avatar?.getAttribute('data-openbitfun-avatar-id')).toBe(presentation.avatarId);
    expect(avatar?.querySelector('img')?.getAttribute('src')).toBe(
      getSubagentAvatarDefinition(presentation.avatarId).src,
    );
    expect(container.querySelector('[data-openbitfun-part="avatar"] > svg')).toBeNull();
    expect(container.textContent).toContain('Agent 1');
  });

  it('stays collapsed and disables expansion while parameters are streaming', async () => {
    await act(async () => {
      root.render(
        <AgentControlToolCard
          toolItem={agentToolItem('AgentSpawn')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-openbitfun-tool-card="agent-control"] [data-openbitfun-part="surface"]')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Inspect the parser flow and report findings.');

    const streamingItem = agentToolItem('AgentSpawn', {
      status: 'streaming',
      isParamsStreaming: true,
      partialParams: {
        agent_id: 'parser-review',
        agent_type: 'SwarmWorker',
        prompt: 'Partial prompt that must stay collapsed.',
      },
    });

    await act(async () => {
      root.render(
        <AgentControlToolCard
          toolItem={streamingItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(
      container
        .querySelector('[data-openbitfun-tool-card="agent-control"] [data-openbitfun-part="surface"]')
        ?.getAttribute('data-openbitfun-interactive'),
    ).toBe('false');
    expect(container.querySelector('[data-openbitfun-part="affordanceButton"]')).toBeNull();
    expect(container.textContent).not.toContain('Inspect the parser flow and report findings.');
    expect(
      container.querySelector('[data-openbitfun-part="expandedCollapse"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(container.querySelector('[data-openbitfun-tool-card="agent-control"][data-openbitfun-status="streaming"]')).not.toBeNull();
  });
});
