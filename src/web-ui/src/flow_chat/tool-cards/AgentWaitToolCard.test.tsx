// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolCapsulePresentationProvider } from '@openbitfun/ui/flow-chat';

import type { FlowToolItem, Session, ToolCardConfig } from '../types/flow-chat';
import { resolveSubagentAvatarPresentation, resolveSubagentNameKey } from '../subagent-identity';
import { AgentWaitToolCard } from './AgentWaitToolCard';
import { shouldShowAgentWaitSteeringHint } from './agentWaitSteeringHint';
import flowChatEn from '../../locales/en-US/flow-chat.json';

const { getState, openBtwSessionInAuxPane, storeListeners } = vi.hoisted(() => ({
  getState: vi.fn(),
  openBtwSessionInAuxPane: vi.fn(),
  storeListeners: new Set<() => void>(),
}));

vi.mock('../services/btwSessionPane', () => ({ openBtwSessionInAuxPane }));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: { getState, subscribe: (listener: () => void) => {
    storeListeners.add(listener);
    return () => storeListeners.delete(listener);
  } },
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    useI18n: () => ({
      t: (key: string, options?: Record<string, unknown>) => key.startsWith('subagentIdentity.names.')
        ? flowChatEn.subagentIdentity.names[key.split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names]
        : createTestI18nT('flow-chat')(key, options),
      formatNumber: (value: number) => String(value),
    }),
  };
});

const config: ToolCardConfig = {
  toolName: 'AgentWait',
  displayName: 'Wait for agents',
  icon: 'WAIT',
  requiresConfirmation: false,
  resultDisplayType: 'summary',
  displayMode: 'compact',
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    dialogTurns: [],
    status: 'active',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'normal',
    ...overrides,
  };
}

function item(status: FlowToolItem['status'] = 'running'): FlowToolItem {
  return {
    id: 'agent-wait-1',
    type: 'tool',
    toolName: 'AgentWait',
    status,
    timestamp: 1,
    toolCall: { id: 'agent-wait-1', input: { bg_task_ids: ['a1_bg1'] } },
  };
}

describe('AgentWaitToolCard', () => {
  it('shows the steering hint only for a running top-level OpenBitFun session', () => {
    const topLevel = session();
    expect(shouldShowAgentWaitSteeringHint('running', 'default', topLevel)).toBe(true);
    expect(shouldShowAgentWaitSteeringHint('completed', 'default', topLevel)).toBe(false);
    expect(
      shouldShowAgentWaitSteeringHint('running', 'subagent-projection', topLevel),
    ).toBe(false);
    expect(
      shouldShowAgentWaitSteeringHint('running', 'default', session({ sessionKind: 'subagent' })),
    ).toBe(false);
    expect(
      shouldShowAgentWaitSteeringHint('running', 'default', session({ isHistorical: true })),
    ).toBe(false);
    expect(
      shouldShowAgentWaitSteeringHint('running', 'default', session({ mode: 'acp:codex' })),
    ).toBe(false);
  });

  it('keeps steering guidance in the result dialog while the row shows a concise wait outcome', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
    const html = renderToStaticMarkup(
      <AgentWaitToolCard toolItem={item()} config={config} sessionId="session-1" />,
    );

    expect(html).toContain('Waiting for results');
    expect(html).not.toContain('Send a steering message to end the wait early');
    expect(html).toContain('data-openbitfun-component="tool-relation-row"');
    expect(html).toContain('data-openbitfun-tool-card="agent-wait"');
    expect(html).toContain('data-openbitfun-part="content"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-openbitfun-part="summary"');
    expect(html).not.toContain('data-openbitfun-part="steeringHint"');
  });

  it('uses matching IP avatars and fun names for both subagent participants', () => {
    const launchedTask: FlowToolItem = {
      id: 'task-1', type: 'tool', toolName: 'Task', status: 'completed', timestamp: 1,
      toolCall: { id: 'task-1', input: { run_in_background: true } },
      subagentSessionId: 'child-session',
      toolResult: { success: true, result: { bg_task_id: 'a1_bg1' } },
    };
    const unrelatedTask: FlowToolItem = {
      ...launchedTask,
      id: 'task-2', subagentSessionId: 'other-child',
      toolResult: { success: true, result: { bg_task_id: 'a2_bg1' } },
    };
    getState.mockReturnValue({ sessions: new Map([['session-1', session({
      sessionKind: 'subagent', title: 'Internal worker label',
      dialogTurns: [{ modelRounds: [{ items: [launchedTask, unrelatedTask] }] }] as unknown as Session['dialogTurns'],
    })]]) });
    const nameKey = resolveSubagentNameKey('child-session').split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names;
    const html = renderToStaticMarkup(
      <ToolCapsulePresentationProvider value={{
        label: 'Wait for subagents', description: 'Wait for subagents · running',
        statusLabel: 'Running', status: 'running', expanded: false, onExpandedChange: vi.fn(),
      }}>
        <AgentWaitToolCard toolItem={item()} config={config} sessionId="session-1" />
      </ToolCapsulePresentationProvider>,
    );

    expect(html).toContain(`data-openbitfun-avatar-id="${resolveSubagentAvatarPresentation('child-session').avatarId}"`);
    expect(html).toContain(flowChatEn.subagentIdentity.names[nameKey]);
    expect(html).toContain(flowChatEn.toolCards.interaction.currentSession);
    expect(html).toContain(`data-openbitfun-avatar-id="${resolveSubagentAvatarPresentation('session-1').avatarId}"`);
    expect(html).not.toContain('Internal worker label');
    expect(html).not.toContain('other-child');
    expect(html).toContain('data-operation="receive"');
    expect(html).toContain('lucide-arrow-left');
    expect(html).not.toContain('data-openbitfun-component="status-pill"');
    expect(html.indexOf('data-openbitfun-part="source"')).toBeLessThan(html.indexOf('data-openbitfun-part="targets"'));
  });

  it('renders the corresponding IP when AgentSpawn records only an agent alias and background ID', () => {
    const spawn: FlowToolItem = {
      id: 'spawn', type: 'tool', toolName: 'AgentSpawn', status: 'completed', timestamp: 1,
      toolCall: { id: 'launch', input: { agent_id: 'reviewer' } },
      toolResult: { success: true, result: { status: 'started', agent_id: 'reviewer', bg_task_id: 'a1_bg1' } },
    };
    getState.mockReturnValue({ sessions: new Map([
      ['session-1', session({ dialogTurns: [{ modelRounds: [{ items: [spawn] }] }] as unknown as Session['dialogTurns'] })],
      ['child-session', session({ sessionId: 'child-session', sessionKind: 'subagent', parentSessionId: 'session-1', parentToolCallId: 'launch' })],
    ]) });
    const html = renderToStaticMarkup(<AgentWaitToolCard toolItem={item()} config={config} sessionId="session-1" />);
    const nameKey = resolveSubagentNameKey('child-session').split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names;
    expect(html).toContain(`data-openbitfun-avatar-id="${resolveSubagentAvatarPresentation('child-session').avatarId}"`);
    expect(html).toContain(flowChatEn.subagentIdentity.names[nameKey]);
    expect(html).toContain('data-openbitfun-part="target"');
    expect(html).not.toContain('lucide-bot');
  });

  it.each(['running', 'completed', 'cancelled', 'error'] as const)(
    'keeps unresolved %s participants as hatch artwork with the generic subagent name', status => {
      const wait = item(status);
      getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        act(() => root.render(<AgentWaitToolCard toolItem={wait} config={config} sessionId="session-1" />));
        const target = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="target"]')!;
        expect(target.querySelector('[data-overflow-content]')?.textContent).toBe(flowChatEn.toolCards.interaction.unknownAgent);
        expect(target.disabled).toBe(true);
        expect(target.hasAttribute('data-openbitfun-affordance')).toBe(false);
        expect(target.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase'))
          .toBe(status === 'running' ? 'incubating' : 'stopped');
        expect(container.querySelector('.lucide-bot')).toBeNull();
        expect(container.querySelector('[data-openbitfun-avatar-id]')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('keeps the hatch fallback for an unspecified target and stops historical animation', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session({ isHistorical: true })]]) });
    const wait = item();
    wait.toolCall.input = {};
    const html = renderToStaticMarkup(<AgentWaitToolCard toolItem={wait} config={config} sessionId="session-1" />);
    expect(html).toContain('data-openbitfun-component="subagent-hatch"');
    expect(html).toContain('data-phase="stopped"');
    expect(html).not.toContain('lucide-bot');
  });

  it('hydrates an unresolved target in place and enables its real session navigation', () => {
    const spawn: FlowToolItem = {
      id: 'spawn', type: 'tool', toolName: 'AgentSpawn', status: 'completed', timestamp: 1,
      toolCall: { id: 'launch', input: { agent_id: 'worker' } },
      toolResult: { success: true, result: { agent_id: 'worker', bg_task_id: 'a1_bg1' } },
    };
    const sessions = new Map([['session-1', session({
      dialogTurns: [{ modelRounds: [{ items: [spawn] }] }] as unknown as Session['dialogTurns'],
    })]]);
    getState.mockImplementation(() => ({ sessions }));
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<AgentWaitToolCard toolItem={item()} config={config} sessionId="session-1" />));
      const target = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="target"]')!;
      const hatch = target.querySelector('[data-openbitfun-component="subagent-hatch"]');
      expect(target.querySelector('[data-overflow-content]')?.textContent).toBe(flowChatEn.toolCards.interaction.unknownAgent);
      expect(target.disabled).toBe(true);
      act(() => {
        sessions.set('child-session', session({ sessionId: 'child-session', sessionKind: 'subagent',
          parentSessionId: 'session-1', parentToolCallId: 'launch' }));
        storeListeners.forEach(listener => listener());
      });
      expect(container.querySelector('[data-openbitfun-part="target"]')).toBe(target);
      expect(target.querySelector('[data-openbitfun-component="subagent-hatch"]')).toBe(hatch);
      expect(hatch?.getAttribute('data-phase')).toBe('ready');
      expect(target.disabled).toBe(false);
      const resolvedNameKey = resolveSubagentNameKey('child-session').split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names;
      expect(target.querySelector('[data-overflow-content]')?.textContent).toBe(flowChatEn.subagentIdentity.names[resolvedNameKey]);
      expect(target.querySelector('[data-openbitfun-avatar-id]')?.getAttribute('data-openbitfun-avatar-id'))
        .toBe(resolveSubagentAvatarPresentation('child-session').avatarId);
      act(() => target.click());
      expect(openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'child-session' }));
    } finally {
      act(() => root.unmount());
      openBtwSessionInAuxPane.mockClear();
    }
  });

  it('opens the selected avatar in the right pane without expanding the wait card', () => {
    const tasks: FlowToolItem[] = ['first-child', 'second-child'].map((childId, index) => ({
      id: `task-${index + 1}`, type: 'tool', toolName: 'Task', status: 'completed', timestamp: index + 1,
      toolCall: { id: `launch-${index + 1}`, input: { run_in_background: true } },
      subagentSessionId: childId,
      toolResult: { success: true, result: { bg_task_id: `a${index + 1}_bg1` } },
    }));
    const parent = session({
      workspacePath: 'D:\\workspace\\repo',
      remoteConnectionId: 'remote-1',
      dialogTurns: [{ modelRounds: [{ items: tasks }] }] as unknown as Session['dialogTurns'],
    });
    getState.mockReturnValue({ sessions: new Map([
      ['session-1', parent],
      ['second-child', session({
        sessionId: 'second-child', parentSessionId: 'session-1', sessionKind: 'subagent',
        parentToolCallId: 'saved-launch', subagentType: 'Researcher',
      })],
    ]) });
    const wait = item();
    wait.toolCall.input = { bg_task_ids: ['a1_bg1', 'a2_bg1'] };
    const onExpandedChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(
        <ToolCapsulePresentationProvider value={{
          label: 'Wait for subagents', description: 'Wait for subagents · running',
          statusLabel: 'Running', status: 'running', expanded: true, onExpandedChange,
          fallbackContent: <div>Expandable record</div>,
        }}>
          <AgentWaitToolCard toolItem={wait} config={config} sessionId="session-1" />
        </ToolCapsulePresentationProvider>,
      ));
      const surface = container.querySelector('[data-openbitfun-component="tool-relation-row"]');
      expect(surface?.tagName).toBe('DIV');
      expect(surface?.hasAttribute('data-openbitfun-expandable')).toBe(false);
      expect(container.textContent).not.toContain('Expandable record');
      const avatarButtons = container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-part="target"]');
      expect(avatarButtons).toHaveLength(2);
      expect(avatarButtons[0].querySelector('[data-subagent-motion-art] svg')).not.toBeNull();
      expect(avatarButtons[1].querySelector('[data-subagent-motion-art] svg')).not.toBeNull();
      act(() => avatarButtons[1].click());
      expect(openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
        childSessionId: 'second-child',
        parentSessionId: 'session-1',
        parentToolCallId: 'saved-launch',
        subagentType: 'Researcher',
        remoteConnectionId: 'remote-1',
        includeInternal: true,
      }));
      expect(onExpandedChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
      openBtwSessionInAuxPane.mockClear();
    }
  });

  it('keeps every target independently accessible without row scrolling controls', () => {
    const tasks: FlowToolItem[] = Array.from({ length: 6 }, (_, index) => ({
      id: `task-${index}`, type: 'tool', toolName: 'Task', status: 'completed', timestamp: index,
      toolCall: { id: `launch-${index}`, input: { run_in_background: true } },
      subagentSessionId: `child-${index}`,
      toolResult: { success: true, result: { bg_task_id: `a${index}_bg1` } },
    }));
    getState.mockReturnValue({ sessions: new Map([['session-1', session({
      dialogTurns: [{ modelRounds: [{ items: tasks }] }] as unknown as Session['dialogTurns'],
    })]]) });
    const wait = item();
    wait.toolCall.input = { bg_task_ids: tasks.map((_, index) => `a${index}_bg1`) };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<AgentWaitToolCard toolItem={wait} config={config} sessionId="session-1" />));
      const targets = container.querySelectorAll('[data-openbitfun-part="target"]');
      expect(targets).toHaveLength(6);
      expect(container.querySelector('[data-agent-wait-scroll]')).toBeNull();
      expect(container.querySelector('[aria-expanded]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('renders a normal steered result without the running hint', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
    const completed = item('completed');
    completed.toolResult = {
      success: true,
      result: { status: 'steered', results: [], pending_bg_task_ids: ['a1_bg1'] },
    };
    const html = renderToStaticMarkup(
      <AgentWaitToolCard toolItem={completed} config={config} sessionId="session-1" />,
    );

    expect(html).toContain('Wait ended early');
    expect(html).not.toContain('Send a steering message');
  });

  it('formats failures with an optional error detail', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
    const failed = item('error');
    failed.toolResult = { success: false, result: {}, error: 'database unavailable' };
    const withDetail = renderToStaticMarkup(
      <AgentWaitToolCard toolItem={failed} config={config} sessionId="session-1" />,
    );
    expect(withDetail).toContain(flowChatEn.toolCards.default.failed);
    expect(withDetail).toContain('aria-haspopup="dialog"');
    expect(withDetail).not.toContain('data-openbitfun-part="extra"');

    failed.toolResult = { success: false, result: {} };
    const withoutDetail = renderToStaticMarkup(
      <AgentWaitToolCard toolItem={failed} config={config} sessionId="session-1" />,
    );
    expect(withoutDetail).toContain(flowChatEn.toolCards.default.failed);
  });

  it('distinguishes an unknown wait result from a recorded empty result', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
    const completed = item('completed');
    completed.toolResult = { success: true, result: {} };
    const unknown = renderToStaticMarkup(<AgentWaitToolCard toolItem={completed} config={config} sessionId="session-1" />);
    expect(unknown).toContain('Received results');
    expect(unknown).not.toContain('Wait result received');
    completed.toolResult.result = { results: [] };
    const empty = renderToStaticMarkup(<AgentWaitToolCard toolItem={completed} config={config} sessionId="session-1" />);
    expect(empty).toContain('data-openbitfun-part="result"');
    expect(empty).toContain('No new results');
  });

  it('shows returned content in the dialog without internal IDs or repeated result counts', () => {
    getState.mockReturnValue({ sessions: new Map([['session-1', session()]]) });
    const completed = item('completed');
    completed.toolResult = { success: true, result: { results: [
      { bg_task_id: 'a1_bg1', agent_id: 'internal-alias', outcome: 'completed', content: 'The release is ready.' },
    ] } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<AgentWaitToolCard toolItem={completed} config={config} sessionId="session-1" />));
      act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="result"]')!.click());
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('The release is ready.');
      expect(dialog?.textContent).not.toContain('a1_bg1');
      expect(dialog?.textContent).not.toContain('internal-alias');
      expect(dialog?.textContent).not.toContain('Results received: 1');
      expect(dialog?.querySelector('[data-openbitfun-part="field"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
