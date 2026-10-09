import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DialogTurn, FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import {
  resolveSubagentAvatarPresentation,
  resolveSubagentNameKey,
} from '../subagent-identity';
import { AgentControlToolCard } from './AgentControlToolCard';
import flowChatEn from '../../locales/en-US/flow-chat.json';
import flowChatZh from '../../locales/zh-CN/flow-chat.json';

const mocks = vi.hoisted(() => ({
  openBtwSessionInAuxPane: vi.fn(),
  listeners: new Set<() => void>(),
  includeChildSession: true,
  locale: 'en-US',
  modelName: 'Test model',
  childTurnStatus: 'processing' as DialogTurn['status'],
  needsUserAttention: false,
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    currentLanguage: mocks.locale,
    t: (key: string, options?: Record<string, unknown>) => {
      if (key.startsWith('subagentIdentity.names.')) {
        const names = (mocks.locale === 'zh-CN' ? flowChatZh : flowChatEn).subagentIdentity.names;
        return names[key.split('.').at(-1) as keyof typeof names];
      }
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
          needsUserAttention: mocks.needsUserAttention,
          config: { agentType: 'SwarmWorker', modelName: mocks.modelName },
          dialogTurns: [{
            id: 'child-turn',
            status: mocks.childTurnStatus,
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

  async function revealPreview() {
    vi.useFakeTimers();
    await act(async () => {
      container.querySelector('[data-agent-capsule-trigger]')!.dispatchEvent(
        new dom.window.MouseEvent('mouseover', { bubbles: true }),
      );
    });
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { vi.advanceTimersByTime(30); });
    return document.querySelector<HTMLElement>('[role="tooltip"]')!;
  }

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
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('CustomEvent', window.CustomEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    mocks.includeChildSession = true;
    mocks.locale = 'en-US';
    mocks.modelName = 'Test model';
    mocks.childTurnStatus = 'processing';
    mocks.needsUserAttention = false;
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
    vi.useRealTimers();
  });

  it('shows an incubating egg only for a new spawn, then stops on failure', () => {
    mocks.includeChildSession = false;
    const render = (toolName: 'AgentSpawn' | 'AgentSendInput', status: FlowToolItem['status']) => act(() => root.render(
      <AgentControlToolCard toolItem={agentToolItem(toolName, { status, subagentSessionId: undefined })}
        config={{ ...config, toolName }} sessionId="parent-session" />,
    ));
    render('AgentSpawn', 'receiving');
    expect(container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase')).toBe('incubating');
    expect(container.querySelector('[data-openbitfun-part="agentSummary"]')?.textContent).toBe('toolCards.interaction.unknownAgent');
    render('AgentSpawn', 'error');
    expect(container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase')).toBe('stopped');
    render('AgentSendInput', 'running');
    expect(container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase')).toBe('stopped');
    expect(container.querySelector('[data-openbitfun-part="target"] [data-overflow-content]')?.textContent).toBe('toolCards.interaction.unknownAgent');
    expect(container.querySelector('.lucide-bot')).toBeNull();
  });

  it.each(['AgentSpawn'] as const)(
    'opens %s directly in the side pane and never expands the prompt inline',
    async (toolName) => {
      await act(async () => root.render(
        <AgentControlToolCard toolItem={agentToolItem(toolName)} config={{ ...config, toolName }} sessionId="parent-session" />,
      ));
      const card = container.querySelector('[data-openbitfun-tool-card="agent-control"]')!;
      const button = card.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!;
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute('aria-expanded')).toBe(false);
      expect(card.querySelector('[data-openbitfun-part="expandedCollapse"]')).toBeNull();
      expect(card.querySelectorAll('button')).toHaveLength(1);
      const nameId = resolveSubagentNameKey('child-session').split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names;
      expect(card.textContent).toContain(flowChatEn.subagentIdentity.names[nameId]);
      expect(card.querySelector('[data-openbitfun-part="agentStatus"]')?.getAttribute('data-status')).toBe('running');
      expect(button.getAttribute('aria-label')).toContain('Running');
      expect(card.textContent).not.toContain('Inspect the parser flow');
      expect(card.querySelector('[data-openbitfun-part="processing"]')).toBeNull();
      await act(async () => button.click());
      expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
        childSessionId: 'child-session',
        parentSessionId: 'parent-session',
        parentToolCallId: 'agent-call',
        sessionKind: 'subagent',
        remoteConnectionId: 'remote-1',
        remoteSshHost: 'host-1',
        includeInternal: true,
      }));
      expect(card.querySelector('[data-openbitfun-part="expandedCollapse"]')).toBeNull();
    },
  );

  it('keeps a finishing child labelled Running and stops the highlight when waiting or complete', async () => {
    await act(async () => root.render(
      <AgentControlToolCard toolItem={agentToolItem('AgentSpawn')} config={config} sessionId="parent-session" />,
    ));
    const highlight = () => container.querySelector('[data-openbitfun-component="shimmer-text"]');
    const publish = () => act(() => { mocks.listeners.forEach(listener => listener()); });

    expect(highlight()?.textContent).toBe('Running');
    mocks.childTurnStatus = 'finishing';
    publish();
    expect(highlight()?.textContent).toBe('Running');
    expect(container.querySelector('[data-agent-capsule-trigger]')?.getAttribute('aria-label')).not.toContain('finishing');

    mocks.needsUserAttention = true;
    publish();
    expect(highlight()).toBeNull();
    mocks.needsUserAttention = false;
    publish();
    expect(highlight()?.textContent).toBe('Running');

    mocks.childTurnStatus = 'completed';
    publish();
    expect(highlight()).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="agentStatus"]')).toBeNull();
  });

  it('can open a historical child before its session is hydrated', async () => {
    mocks.includeChildSession = false;
    await act(async () => root.render(
      <AgentControlToolCard toolItem={agentToolItem('AgentSpawn')} config={config} sessionId="parent-session" />,
    ));
    const avatar = container.querySelector('[data-openbitfun-component="subagent-avatar"]');
    expect(avatar?.getAttribute('data-openbitfun-avatar-id')).toBe(resolveSubagentAvatarPresentation('child-session').avatarId);
    expect(avatar?.querySelector('[data-subagent-motion-art] svg')).not.toBeNull();
    expect(avatar?.querySelector('.subagent-avatar__status')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!.click());
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledOnce();
  });

  it('keeps an unlinked streaming launch non-interactive until its child is known', async () => {
    mocks.includeChildSession = false;
    const item = agentToolItem('AgentSpawn', { status: 'streaming', isParamsStreaming: true, subagentSessionId: undefined });
    await act(async () => root.render(
      <AgentControlToolCard toolItem={item} config={config} sessionId="parent-session" />,
    ));
    const button = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    await act(async () => button.click());
    expect(mocks.openBtwSessionInAuxPane).not.toHaveBeenCalled();
    mocks.includeChildSession = true;
    await act(async () => { for (const listener of mocks.listeners) listener(); });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(container.querySelector('[data-openbitfun-avatar-id]')?.getAttribute('data-openbitfun-avatar-id'))
      .toBe(resolveSubagentAvatarPresentation('child-session').avatarId);
    expect(container.querySelector('[data-openbitfun-part="agentSummary"]')?.textContent)
      .toBe(flowChatEn.subagentIdentity.names.cloudHopper);
  });

  it('shows a delivered instruction independently of the running child and retains its pane action', async () => {
    const item = agentToolItem('AgentSendInput');
    item.toolCall!.input = { agent_id: 'worker', prompt: 'Continue with the parser fix' };
    await act(async () => root.render(
      <AgentControlToolCard toolItem={item} config={config} sessionId="parent-session" />,
    ));
    const card = container.querySelector('[data-openbitfun-tool-card="session-message"]')!;
    expect(card.getAttribute('data-openbitfun-status')).toBe('completed');
    expect(card.getAttribute('data-operation')).toBe('send');
    expect(card.querySelector('[data-openbitfun-part="source"]')?.textContent).toBe('toolCards.interaction.currentSession');
    expect(card.querySelector('[data-openbitfun-part="target"] [data-overflow-content]')?.textContent).toBe(flowChatEn.subagentIdentity.names.cloudHopper);
    expect(card.querySelector('[data-openbitfun-part="target"] [data-openbitfun-avatar-id]')).not.toBeNull();
    expect(card.querySelector('[data-openbitfun-part="processing"]')).toBeNull();
    expect(card.textContent).not.toContain('Continue with the parser fix');
    await act(async () => card.querySelector<HTMLButtonElement>('[data-openbitfun-part="target"]')!.click());
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'child-session', remoteConnectionId: 'remote-1', remoteSshHost: 'host-1',
    }));
    expect(card.hasAttribute('data-openbitfun-expandable')).toBe(false);
    expect(card.querySelector('[aria-expanded]')).toBeNull();
    await act(async () => card.querySelector<HTMLButtonElement>('[data-openbitfun-part="result"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Continue with the parser fix');
  });

  it('keeps rejected and failed sends visible instead of substituting the child lifecycle', async () => {
    for (const status of ['error', 'rejected', 'cancelled'] as const) {
      await act(async () => root.render(
        <AgentControlToolCard toolItem={agentToolItem('AgentSendInput', { status })} config={config} sessionId="parent-session" />,
      ));
      const card = container.querySelector('[data-openbitfun-tool-card="session-message"]')!;
      expect(card.getAttribute('data-openbitfun-status')).toBe(status);
      expect(card.querySelector('[data-openbitfun-part="interactionStatus"]')).toBeNull();
      expect(card.querySelector('[data-openbitfun-part="target"]')?.hasAttribute('data-tone')).toBe(false);
      expect(card.querySelector('[data-openbitfun-part="result"]')?.textContent)
        .toContain(`toolCards.default.${status === 'error' ? 'failed' : status}`);
    }
  });

  it('distinguishes an interrupt with no active work from a cancelled send', async () => {
    const toolItem = { ...agentToolItem('AgentSendInput'), toolName: 'AgentInterrupt',
      toolResult: { success: true, result: { agent_id: 'worker', interrupted_background_tasks: 0 } } };
    await act(async () => root.render(<AgentControlToolCard toolItem={toolItem} config={config} sessionId="parent-session" />));
    const card = container.querySelector('[data-openbitfun-tool-card="session-message"]')!;
    expect(card.getAttribute('data-openbitfun-status')).toBe('completed');
    expect(card.getAttribute('data-operation')).toBe('interrupt');
    expect(card.querySelector('[data-openbitfun-part="source"]')).not.toBeNull();
    expect(card.querySelector('[data-openbitfun-part="result"]')?.textContent).toBe('toolCards.interaction.noActiveRuns');
  });

  it('shows only the current language and keeps the same name through history hydration', async () => {
    mocks.includeChildSession = false;
    const renderCard = () => act(async () => root.render(
      <AgentControlToolCard toolItem={agentToolItem('AgentSpawn')} config={config} sessionId="parent-session" />,
    ));
    await renderCard();
    const name = () => container.querySelector('[data-openbitfun-part="agentSummary"]')?.textContent;
    expect(name()).toBe(flowChatEn.subagentIdentity.names.cloudHopper);
    mocks.includeChildSession = true;
    await act(async () => { for (const listener of mocks.listeners) listener(); });
    expect(name()).toBe(flowChatEn.subagentIdentity.names.cloudHopper);
    mocks.locale = 'zh-CN';
    await renderCard();
    expect(name()).toBe(flowChatZh.subagentIdentity.names.cloudHopper);
    expect(container.textContent).not.toContain(flowChatEn.subagentIdentity.names.cloudHopper);
    expect(container.querySelector('[lang]')?.getAttribute('lang')).toBe('zh-CN');
  });

  it('shows live type and model on the card while retaining the full preview and pane action', async () => {
    const description = 'Investigate the parser and preserve the complete task description. '.repeat(30);
    const item = agentToolItem('AgentSpawn');
    item.toolCall!.input = { ...item.toolCall!.input, description };
    await act(async () => root.render(
      <AgentControlToolCard toolItem={item} config={config} sessionId="parent-session" />,
    ));
    expect(container.textContent).not.toContain(description);
    expect(container.querySelector('[data-openbitfun-part="agentType"]')?.textContent).toBe('SwarmWorker');
    expect(container.querySelector('[data-openbitfun-part="agentModel"]')?.textContent).toBe('Test model');
    expect(container.querySelector('[title]')).toBeNull();
    const popup = await revealPreview();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup.dataset.openbitfunInteractive).toBe('true');
    expect(popup.querySelector('[data-openbitfun-part="previewName"]')?.textContent).toBe(flowChatEn.subagentIdentity.names.cloudHopper);
    expect(popup.querySelector('[data-openbitfun-component="subagent-avatar"]')).toBeTruthy();
    expect(popup.querySelector('[data-openbitfun-part="previewAgentType"]')?.textContent).toBe('SwarmWorker');
    expect(popup.querySelector('[data-openbitfun-part="previewModel"]')?.textContent).toBe('Test model');
    expect(popup.querySelector('[data-openbitfun-part="previewDescription"]')?.textContent).toBe(description.trim());
    const button = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!;
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: popup }));
      popup.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: button }));
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector('[role="tooltip"]')).toBe(popup);
    mocks.modelName = 'Updated model';
    await act(async () => { for (const listener of mocks.listeners) listener(); });
    expect(container.querySelector('[data-openbitfun-part="agentModel"]')?.textContent).toBe('Updated model');
    expect(popup.querySelector('[data-openbitfun-part="previewModel"]')?.textContent).toBe('Updated model');
    await act(async () => popup.click());
    expect(mocks.openBtwSessionInAuxPane).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
