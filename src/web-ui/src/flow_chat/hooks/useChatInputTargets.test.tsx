// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAgentCanvasForPeerSwitch, useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '../store/FlowChatStore';
import { buildBtwSessionPanelContent, selectActiveBtwSessionTab, type BtwSessionPanelData } from '../services/btwSessionPane';
import type { Session } from '../types/flow-chat';
import { useChatInputTargets } from './useChatInputTargets';

vi.mock('../services/FlowChatManager', () => ({ flowChatManager: {} }));

describe('composer target lifecycle through production stores', () => {
  let root: Root;
  let container: HTMLDivElement;
  let target: ReturnType<typeof useChatInputTargets>;
  function Probe() {
    const state = flowChatStore.getState();
    target = useChatInputTargets({ currentSessionId: state.activeSessionId,
      sessions: state.sessions, auxiliaryEnabled: true,
      activeChild: selectActiveBtwSessionTab(useAgentCanvasStore.getState())?.content.data as BtwSessionPanelData | undefined });
    return null;
  }
  const render = () => act(() => root.render(<Probe />));
  const setSession = (id: string, fields: Partial<Session> = {}) => {
    flowChatStore.setState(state => ({ ...state, sessions: new Map(state.sessions).set(id, {
      sessionId: id, dialogTurns: [], config: {}, createdAt: 1, lastActiveAt: 1, status: 'idle', error: null,
      ...state.sessions.get(id), ...fields,
    }) }));
  };
  const openChild = (id: string, viewKind?: 'review-check') => {
    act(() => useAgentCanvasStore.getState().addTab(buildBtwSessionPanelContent(id, 'main', {}, viewKind), 'active'));
    render();
  };
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    clearAgentCanvasForPeerSwitch();
    flowChatStore.setState(state => ({ ...state, activeSessionId: 'main', sessions: new Map() }));
    setSession('main');
    setSession('a', { sessionKind: 'subagent', parentSessionId: 'main', continuationPolicy: 'reusable' });
    setSession('b', { sessionKind: 'subagent', parentSessionId: 'main', continuationPolicy: 'reusable' });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    clearAgentCanvasForPeerSwitch();
    flowChatStore.setState(state => ({ ...state, activeSessionId: null, sessions: new Map() }));
    container.remove();
  });

  it('filters pointer, keyboard and programmatic selection with the same capability', () => {
    setSession('a', { continuationPolicy: 'fresh_only' });
    openChild('a');
    expect(target.showSwitcher).toBe(false);
    act(() => target.selectTarget('btw'));
    act(() => target.selectTargetSession('a'));
    expect(target.effectiveSessionId).toBe('main');
    expect(target.isTargetCurrent('a')).toBe(false);
  });

  it('does not transfer selection to a newly opened sibling or revive old selection', () => {
    openChild('a');
    act(() => target.selectTargetSession('a'));
    expect(target.effectiveSessionId).toBe('a');
    const originalPane = selectActiveBtwSessionTab(useAgentCanvasStore.getState())!;
    openChild('b');
    expect(target.effectiveSessionId).toBe('main');
    act(() => useAgentCanvasStore.getState().switchToTab(originalPane.id, 'primary'));
    render();
    expect(target.effectiveSessionId).toBe('main');
  });

  it('invalidates a pending send immediately, before React re-renders', () => {
    openChild('a');
    act(() => target.selectTargetSession('a'));
    const pendingSendIsCurrent = target.isTargetCurrent;
    setSession('a', { continuationPolicy: 'fresh_only' });
    expect(pendingSendIsCurrent('a')).toBe(false);
    render();
    expect(target.effectiveSessionId).toBe('main');
    expect(target.showSwitcher).toBe(false);
    setSession('a', { continuationPolicy: 'reusable' });
    render();
    expect(target.showSwitcher).toBe(true);
    expect(target.effectiveSessionId).toBe('main');
  });

  it('shows only an eligible main target for review detail views', () => {
    openChild('a', 'review-check');
    expect(target.showSwitcher).toBe(false);
    act(() => target.selectTargetSession('a'));
    expect(target.effectiveSessionId).toBe('main');
  });

  it('waits for child metadata and never automatically selects the hydrated child', () => {
    setSession('a', { continuationPolicy: undefined });
    openChild('a');
    expect(target.showSwitcher).toBe(false);
    setSession('a', { continuationPolicy: 'reusable' });
    render();
    expect(target.showSwitcher).toBe(true);
    expect(target.effectiveSessionId).toBe('main');
  });
});
