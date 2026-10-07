// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { appManager } from '../../services/AppManager';
import { clearSessionAuxPaneMemory, startSessionAuxPaneMemory } from './sessionAuxPaneMemory';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

function session(sessionId: string): Session {
  return {
    sessionId,
    title: sessionId,
    dialogTurns: [],
    status: 'idle',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
  };
}

function seed(sessionIds: string[]): void {
  flowChatStore.setState(previous => ({
    ...previous,
    sessions: new Map(sessionIds.map(id => [id, session(id)])),
    activeSessionId: null,
  }));
}

const collapsed = () => appManager.getState().layout.rightPanelCollapsed;
const setCollapsed = (value: boolean) => appManager.updateLayout({ rightPanelCollapsed: value });

describe('session aux pane memory', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    activateSurface('local');
    clearSessionAuxPaneMemory();
    appManager.updateLayout({ chatCollapsed: false, rightPanelCollapsed: true });
    seed(['a', 'b']);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    activateSurface('local');
  });

  it('restores a remembered session and uses the collapsed default for an unseen one', () => {
    stop = startSessionAuxPaneMemory();

    flowChatStore.switchSession('a');
    setCollapsed(false);
    flowChatStore.switchSession('b');
    expect(collapsed()).toBe(true);
    flowChatStore.switchSession('a');
    expect(collapsed()).toBe(false);
  });

  it('keeps an independent state per session', () => {
    stop = startSessionAuxPaneMemory();

    flowChatStore.switchSession('a');
    setCollapsed(false);
    flowChatStore.switchSession('b');
    setCollapsed(false);
    flowChatStore.switchSession('a');
    setCollapsed(true);
    expect(collapsed()).toBe(true);

    flowChatStore.switchSession('b');
    expect(collapsed()).toBe(false);
    flowChatStore.switchSession('a');
    expect(collapsed()).toBe(true);
  });

  it('restores fullscreen only when returning to the session that requested it', () => {
    stop = startSessionAuxPaneMemory();

    flowChatStore.switchSession('a');
    appManager.updateLayout({ chatCollapsed: true, rightPanelCollapsed: false });
    flowChatStore.switchSession('b');

    expect(collapsed()).toBe(true);
    expect(appManager.getState().layout.chatCollapsed).toBe(false);
    flowChatStore.switchSession('a');
    expect(collapsed()).toBe(false);
    expect(appManager.getState().layout.chatCollapsed).toBe(true);
  });

  it('isolates identical session ids on different device surfaces', () => {
    stop = startSessionAuxPaneMemory();
    flowChatStore.switchSession('a');
    appManager.updateLayout({ chatCollapsed: true, rightPanelCollapsed: false });
    activateSurface('pane-test-peer');
    seed(['a']);
    flowChatStore.switchSession('a');
    expect(collapsed()).toBe(true);
    setCollapsed(false);
    activateSurface('local');
    expect(appManager.getState().layout.chatCollapsed).toBe(true);
    activateSurface('pane-test-peer');
    expect(appManager.getState().layout.chatCollapsed).toBe(false);
    expect(collapsed()).toBe(false);
  });

  it('does not attribute an active session when there is none', () => {
    stop = startSessionAuxPaneMemory();

    setCollapsed(false);
    flowChatStore.switchSession('a');

    expect(collapsed()).toBe(true);
  });

  it('stops tracking sessions after the shell unmounts', () => {
    stop = startSessionAuxPaneMemory();
    flowChatStore.switchSession('a');
    setCollapsed(false);
    stop();
    stop = undefined;

    flowChatStore.switchSession('b');

    expect(collapsed()).toBe(false);
  });
});
