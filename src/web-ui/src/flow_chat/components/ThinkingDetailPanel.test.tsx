// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import { FLOWCHAT_FOCUS_ITEM_EVENT } from '../events/flowchatNavigation';
import { createTab } from '@/shared/utils/tabUtils';
import { ThinkingDetailPanel } from './ThinkingDetailPanel';
import { openThinkingPanel, type ThinkingDetailPanelData } from '../services/openThinkingPanel';
import type { FlowChatState, FlowThinkingItem, Session } from '../types/flow-chat';

const markdownRender = vi.hoisted(() => vi.fn());
let state: FlowChatState;
const listeners = new Set<() => void>();

vi.mock('@/shared/utils/tabUtils', () => ({ createTab: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/markdown', () => ({
  ThinkingMarkdownRenderer: (props: { content: string; isStreaming: boolean }) => {
    markdownRender(props);
    return <div data-testid="body" data-streaming={props.isStreaming}>{props.content}</div>;
  },
}));
vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => state,
    subscribeSelector: <T,>(select: (value: FlowChatState) => T, notify: () => void) => {
      let previous = select(state);
      const listener = () => {
        const next = select(state);
        if (previous === next) return;
        previous = next;
        notify();
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

const thinking = (content: string, active = true): FlowThinkingItem => ({
  id: 'thinking-1', type: 'thinking', content, reasoningKind: 'reasoning',
  isStreaming: active, status: active ? 'streaming' : 'completed', isCollapsed: true, timestamp: 1,
});
const session = (sessionId: string, item: FlowThinkingItem): Session => ({
  sessionId, dialogTurns: [{ id: 'turn-1', modelRounds: [{ id: 'round-1', items: [item] }] }],
} as Session);

describe('ThinkingDetailPanel source lifetime', () => {
  let container: HTMLDivElement;
  let root: Root;
  let data: ThinkingDetailPanelData;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    state = { sessions: new Map(), activeSessionId: 'other-session' } as FlowChatState;
    data = {
      surfaceId: 'local', sessionId: 'source-session', thinkingItem: thinking('At open'),
      workspaceId: 'workspace-1', workspacePath: '/srv/project', remoteConnectionId: 'ssh-1',
      navigationTarget: { sessionId: 'source-session', turnId: 'turn-1', itemId: 'thinking-1' },
    };
    markdownRender.mockClear();
    vi.mocked(createTab).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    activateSurface('local');
    vi.unstubAllGlobals();
  });
  const publish = (sessionId: string, item?: FlowThinkingItem) => act(() => {
    const sessions = new Map(state.sessions);
    if (item) sessions.set(sessionId, session(sessionId, item));
    else sessions.delete(sessionId);
    state = { ...state, sessions };
    listeners.forEach(listener => listener());
  });

  it('keeps reading its source independently of the chat row and active session', () => {
    publish('source-session', thinking('Already newer'));
    publish('other-session', thinking('Unrelated'));
    act(() => root.render(<ThinkingDetailPanel data={data} />));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('Already newer');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(markdownRender).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', basePath: '/srv/project', remoteConnectionId: 'ssh-1',
    }));
    const body = container.querySelector('[data-testid="body"]');
    const renders = markdownRender.mock.calls.length;
    publish('other-session', thinking('Other stream'));
    expect(markdownRender).toHaveBeenCalledTimes(renders);
    publish('source-session', thinking('More reasoning'));
    expect(body?.textContent).toBe('More reasoning');
    expect(container.querySelector('[data-testid="body"]')).toBe(body);
    publish('source-session', thinking('Complete reasoning', false));
    expect(body?.getAttribute('data-streaming')).toBe('false');
    expect(body?.textContent).toBe('Complete reasoning');
    publish('source-session');
    expect(body?.textContent).toBe('Complete reasoning');
    act(() => root.render(null));
    expect(listeners.size).toBe(0);
  });

  it('keeps the captured body when history is unavailable and follows it after hydration', () => {
    act(() => root.render(<ThinkingDetailPanel data={data} />));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('At open');
    publish('source-session', thinking('Restored history', false));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('Restored history');
  });

  it('reads historical reasoning from an earlier attempt', () => {
    const original = thinking('Earlier attempt', false);
    const sourceSession = session('source-session', { ...thinking('New attempt'), id: 'other-thinking' });
    sourceSession.dialogTurns[0].modelRounds[0].attempts = [{
      id: 'attempt-1', items: [original],
    } as NonNullable<Session['dialogTurns'][number]['modelRounds'][number]['attempts']>[number]];
    state.sessions.set('source-session', sourceSession);
    act(() => root.render(<ThinkingDetailPanel data={data} />));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('Earlier attempt');
  });

  it('never reads a matching session and item from a different device surface', () => {
    publish('source-session', thinking('Local reasoning', false));
    act(() => root.render(<ThinkingDetailPanel data={data} />));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('Local reasoning');
    act(() => activateSurface('peer-1'));
    publish('source-session', thinking('Peer reasoning'));
    expect(container.querySelector('[data-testid="body"]')).toBeNull();
    publish('source-session', thinking('Local reasoning', false));
    act(() => activateSurface('local'));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('Local reasoning');
  });

  it('reuses a single reader key while replacing its captured source', () => {
    const params = { ...data, title: 'Thinking Process' };
    openThinkingPanel(params);
    openThinkingPanel({ ...params, thinkingItem: thinking('Updated') });
    openThinkingPanel({ ...params, sessionId: 'other-session', thinkingItem: { ...thinking('Another thought'), id: 'thinking-2' } });
    activateSurface('peer-1');
    openThinkingPanel(params);
    const calls = vi.mocked(createTab).mock.calls.map(([options]) => options);
    expect(calls[0].duplicateCheckKey).toBe(calls[1].duplicateCheckKey);
    expect(new Set(calls.map(call => call.duplicateCheckKey)).size).toBe(1);
    expect(calls[3].data.surfaceId).toBe('peer-1');
    expect(calls[1]).toMatchObject({
      type: 'thinking-detail', mode: 'agent', replaceExisting: true,
      data: { sessionId: 'source-session', thinkingItem: { content: 'Updated' }, workspacePath: '/srv/project' },
    });
  });

  it('locates the captured left-side source and refuses navigation on another device', () => {
    const focus = vi.fn();
    const stop = globalEventBus.on(FLOWCHAT_FOCUS_ITEM_EVENT, focus);
    try {
      act(() => root.render(<ThinkingDetailPanel data={data} />));
      act(() => container.querySelector('button')!.click());
      expect(focus).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'source-session', turnId: 'turn-1', itemId: 'thinking-1',
        surfaceEpoch: getActiveSurfaceScope().epoch,
      }));
      act(() => activateSurface('peer-1'));
      expect(container.querySelector('button')?.disabled).toBe(true);
      act(() => container.querySelector('button')!.click());
      expect(focus).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('switches the reader and locator together without accepting updates from the previous source', () => {
    act(() => root.render(<ThinkingDetailPanel data={data} />));
    const next = { ...data, sessionId: 'new-session', thinkingItem: thinking('New source'),
      navigationTarget: { sessionId: 'parent-session', turnId: 'parent-turn', itemId: 'parent-task' } };
    act(() => root.render(<ThinkingDetailPanel data={next} />));
    publish('source-session', thinking('Old stream continues'));
    expect(container.querySelector('[data-testid="body"]')?.textContent).toBe('New source');
    const focus = vi.fn();
    const stop = globalEventBus.on(FLOWCHAT_FOCUS_ITEM_EVENT, focus);
    try {
      act(() => container.querySelector('button')!.click());
      expect(focus).toHaveBeenCalledWith(expect.objectContaining(next.navigationTarget));
    } finally { stop(); }
  });
});
