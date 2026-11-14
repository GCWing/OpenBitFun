// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { SceneTab } from '../components/SceneBar/types';
import { useSessionTabLabels, type SessionTabLabel } from './useSessionTabLabels';
import { createDefaultSessionTitleDescriptor, deriveSessionTitleState } from '@/flow_chat/utils/sessionTitle';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
});

it('projects each referenced title independently of focus and updates replaced resources synchronously', () => {
  const a: Session = {
    sessionId: 'a', title: 'First task', workspacePath: '/alpha', config: {},
    dialogTurns: [], status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
  };
  const b: Session = { ...a, sessionId: 'b', title: 'Second task', workspacePath: '/beta' };
  flowChatStore.setState(state => ({ ...state, sessions: new Map([['a', a], ['b', b]]), activeSessionId: 'b' }));
  let tabs: SceneTab[] = [
    { id: 'session:alpha', lastUsed: 1, session: { surfaceId: 'local', workspaceKey: 'alpha', sessionId: 'a' } },
    { id: 'session:beta', lastUsed: 2, session: { surfaceId: 'local', workspaceKey: 'beta', sessionId: 'b' } },
  ];
  const container = document.createElement('div');
  const root = createRoot(container);
  let labels: Record<string, SessionTabLabel> = {};
  function LabelObserver() { labels = useSessionTabLabels(tabs); return null; }
  try {
    act(() => root.render(<LabelObserver />));
    expect(labels).toEqual({ 'session:alpha': { title: 'First task' }, 'session:beta': { title: 'Second task' } });
    act(() => {
      flowChatStore.setState(state => ({
        ...state, sessions: new Map(state.sessions).set('a', { ...a, title: 'Renamed in background' }),
      }));
    });
    expect(labels['session:alpha'].title).toBe('Renamed in background');
    expect(labels['session:beta'].title).toBe('Second task');
    tabs = [{ ...tabs[0], session: { ...tabs[0].session!, sessionId: 'b' } }];
    act(() => root.render(<LabelObserver />));
    expect(labels).toEqual({ 'session:alpha': { title: 'Second task' } });
  } finally {
    act(() => root.unmount());
  }
});

it('reads only open session titles when another session is updated', () => {
  const a: Session = {
    sessionId: 'a', workspacePath: '/alpha', config: {},
    ...deriveSessionTitleState(createDefaultSessionTitleDescriptor(() => 'New Session')),
    dialogTurns: [], status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
  };
  const b: Session = { ...a, sessionId: 'b' };
  const sessions = new Map([['a', a], ['b', b]]);
  const readCatalog = vi.spyOn(sessions, 'values');
  flowChatStore.setState(state => ({ ...state, sessions, activeSessionId: 'a' }));
  const tabs: SceneTab[] = [
    { id: 'session:alpha', lastUsed: 1, session: { surfaceId: 'local', workspaceKey: 'alpha', sessionId: 'a' } },
  ];
  const root = createRoot(document.createElement('div'));
  let labels: Record<string, SessionTabLabel> = {};
  function LabelObserver() { labels = useSessionTabLabels(tabs); return null; }
  try {
    act(() => root.render(<LabelObserver />));
    const initial = labels;
    expect(initial['session:alpha'].title).toBeTruthy();
    expect(readCatalog).not.toHaveBeenCalled();

    const updatedSessions = new Map(sessions).set('b', { ...b, lastActiveAt: 2 });
    const readUpdatedCatalog = vi.spyOn(updatedSessions, 'values');
    act(() => flowChatStore.setState(state => ({ ...state, sessions: updatedSessions })));
    expect(readUpdatedCatalog).not.toHaveBeenCalled();
    expect(labels).toBe(initial);
  } finally {
    act(() => root.unmount());
  }
});

it('keeps titles tied to each tab device when session IDs match', () => {
  const peer = 'peer-tab-labels';
  const localSession: Session = {
    sessionId: 'shared', title: 'Local title', config: {}, dialogTurns: [],
    status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
  };
  const publish = (session: Session) => flowChatStore.setState(state => ({
    ...state, sessions: new Map([[session.sessionId, session]]),
  }));
  const tabs: SceneTab[] = [
    { id: 'session:local', lastUsed: 1, session: { surfaceId: 'local', workspaceKey: 'project', sessionId: 'shared' } },
    { id: 'session:peer', lastUsed: 1, session: { surfaceId: peer, workspaceKey: 'project', sessionId: 'shared' } },
  ];
  const root = createRoot(document.createElement('div'));
  let labels: Record<string, SessionTabLabel> = {};
  function LabelObserver() { labels = useSessionTabLabels(tabs); return null; }
  try {
    publish(localSession);
    act(() => root.render(<LabelObserver />));
    expect(labels).toEqual({ 'session:local': { title: 'Local title' } });

    act(() => {
      activateSurface(peer);
      publish({ ...localSession, title: 'Peer title' });
    });
    act(() => { activateSurface('local'); });
    expect(labels).toEqual({
      'session:local': { title: 'Local title' },
      'session:peer': { title: 'Peer title' },
    });
  } finally {
    act(() => root.unmount());
    activateSurface('local');
    flowChatStore.discardSurfaceState(peer);
  }
});
