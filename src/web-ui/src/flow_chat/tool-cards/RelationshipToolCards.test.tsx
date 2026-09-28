// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import { SessionMessageToolCard } from './SessionMessageToolCard';
import { SessionControlToolCard } from './SessionControlToolCard';
import { AgentDeleteToolCard } from './AgentDeleteToolCard';
import { getToolItemCardConfig } from './toolCardMetadata';

const state = vi.hoisted(() => ({
  sessions: new Map<string, Session>(), listeners: new Set<() => void>(), openMainSession: vi.fn(),
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: state.sessions }),
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
} }));
vi.mock('../services/sessionActivation', () => ({ openMainSession: state.openMainSession }));
vi.mock('../services/btwSessionPane', () => ({ openBtwSessionInAuxPane: vi.fn() }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  const t = createTestI18nT('flow-chat');
  return { useI18n: () => ({ t, formatNumber: (value: number) => String(value) }) };
});

function session(sessionId: string, title: string): Session {
  return { sessionId, title, sessionKind: 'normal', status: 'active', config: {}, dialogTurns: [],
    createdAt: 1, lastActiveAt: 1, error: null };
}
function item(toolName: string, input: Record<string, unknown>, result: unknown = {}): FlowToolItem {
  return { id: 'relation', type: 'tool', toolName, status: 'completed', timestamp: 1,
    toolCall: { id: 'relation', input }, toolResult: { success: true, result } };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.sessions = new Map([
    ['current', session('current', 'A changing conversation title')],
    ['target', session('target', 'Release review')],
  ]);
  state.openMainSession.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(Component: typeof SessionMessageToolCard | typeof SessionControlToolCard | typeof AgentDeleteToolCard, call: FlowToolItem) {
  act(() => root.render(<Component toolItem={call} config={getToolItemCardConfig(call)} sessionId="current" />));
}
function click(part: string) { act(() => container.querySelector<HTMLButtonElement>(`[data-openbitfun-part="${part}"]`)!.click()); }

describe('session relationship records', () => {
  it('keeps the current-session label after hydration while preserving the target name', () => {
    render(SessionMessageToolCard, item('SessionMessage', { session_id: 'target', message: 'Inspect the release' }));
    expect(container.querySelector('[data-openbitfun-part="source"]')?.textContent).toBe('Current session');
    expect(container.querySelector('[data-openbitfun-part="target"]')?.textContent).toBe('Release review');
    act(() => {
      state.sessions.set('current', session('current', 'A renamed conversation'));
      state.listeners.forEach(listener => listener());
    });
    expect(container.querySelector('[data-openbitfun-part="source"]')?.textContent).toBe('Current session');
    expect(container.textContent).not.toContain('A renamed conversation');
  });

  it('navigates through the recipient and opens the sent message through the result', async () => {
    render(SessionMessageToolCard, item('SessionMessage', { session_id: 'target', message: 'Inspect the release' }));
    expect(container.querySelector('[data-openbitfun-name="arrow-right"]')).not.toBeNull();
    click('target');
    await vi.waitFor(() => expect(state.openMainSession).toHaveBeenCalledWith('target', expect.objectContaining({ isCurrent: expect.any(Function) })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    click('result');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Inspect the release');
    expect(dialog?.querySelector('[data-openbitfun-part="field"]')).toBeNull();
    expect(dialog?.textContent).not.toContain('Sent 1 message');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('retains deleted session details without navigating to a missing session', () => {
    state.sessions.delete('target');
    render(SessionControlToolCard, item('SessionControl', { action: 'delete', session_id: 'target', session_name: 'Release review' }));
    click('target');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Release review');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Deleted the session');
    expect(state.openMainSession).not.toHaveBeenCalled();
  });

  it('distinguishes no active turn from an interruption request', () => {
    render(SessionControlToolCard, item('SessionControl', { action: 'cancel', session_id: 'target' }, { status: 'no_active_turn' }));
    expect(container.querySelector('[data-openbitfun-part="result"]')?.textContent).toBe('No active work');
    render(SessionControlToolCard, item('SessionControl', { action: 'cancel', session_id: 'target' }, { status: 'cancel_requested' }));
    expect(container.querySelector('[data-openbitfun-part="result"]')?.textContent).toBe('Requested interruption');
  });

  it('uses the recorded deletion count and keeps each requested agent inspectable', () => {
    render(AgentDeleteToolCard, item('AgentDelete', { agent_ids: ['worker-a', 'worker-b'] }, { agent_ids: ['worker-a'], deleted_agents: 1 }));
    expect(container.querySelectorAll('[data-openbitfun-part="target"]')).toHaveLength(2);
    expect(container.querySelector('[data-openbitfun-part="result"]')?.textContent).toBe('Agents deleted: 1');
    click('target');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('worker-a');
    expect(state.openMainSession).not.toHaveBeenCalled();
  });
});
