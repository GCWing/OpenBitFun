/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatState, Session } from '../types/flow-chat';
import { useSessionReadOnOpen } from './useSessionReadOnOpen';

const store = vi.hoisted(() => ({
  state: { sessions: new Map<string, Session>() },
  listeners: new Set<() => void>(),
  clear: vi.fn(),
}));
vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    subscribeSelector: (select: (state: FlowChatState) => unknown, notify: () => void) => {
      let previous = select(store.state as FlowChatState);
      const listener = () => {
        const next = select(store.state as FlowChatState);
        if (next !== previous) { previous = next; notify(); }
      };
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    clearSessionUnreadCompletion: (id: string) => {
      if (!store.state.sessions.get(id)?.hasUnreadCompletion) return;
      store.clear(id);
      store.state.sessions.set(id, { ...store.state.sessions.get(id)!, hasUnreadCompletion: undefined });
      store.listeners.forEach(notify => notify());
    },
  },
}));

describe('useSessionReadOnOpen', () => {
  let root: Root;
  let focused: boolean;
  let visible: DocumentVisibilityState;
  function View({ id = 'session', active = true }: { id?: string; active?: boolean }) {
    useSessionReadOnOpen(id, active);
    return null;
  }
  function unread(id = 'session', kind: Session['hasUnreadCompletion'] = 'completed') {
    // No hydrated transcript or rendered result is needed to acknowledge a view.
    store.state.sessions.set(id, { sessionId: id, historyState: 'metadata-only',
      dialogTurns: [], hasUnreadCompletion: kind } as unknown as Session);
    store.listeners.forEach(notify => notify());
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface(LOCAL_SURFACE_ID);
    store.state.sessions.clear();
    store.listeners.clear();
    store.clear.mockClear();
    focused = true;
    visible = 'visible';
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
  });

  it('reads on opening and reads new outcomes while open without inspecting the transcript', async () => {
    unread();
    await act(async () => root.render(<View />));
    expect(store.clear).toHaveBeenCalledTimes(1);
    for (const kind of ['completed', 'error', 'interrupted'] as const) {
      await act(async () => unread('session', kind));
    }
    expect(store.clear).toHaveBeenCalledTimes(4);
  });

  it('retains results in an inactive scene and reads when the scene becomes active', async () => {
    unread();
    await act(async () => root.render(<View active={false} />));
    expect(store.clear).not.toHaveBeenCalled();
    await act(async () => root.render(<View />));
    expect(store.clear).toHaveBeenCalledWith('session');
  });

  it.each(['unfocused', 'hidden'] as const)('retains %s window results until foregrounded', async mode => {
    focused = mode !== 'unfocused';
    visible = mode === 'hidden' ? 'hidden' : 'visible';
    unread();
    await act(async () => root.render(<View />));
    expect(store.clear).not.toHaveBeenCalled();
    focused = true;
    visible = 'visible';
    await act(async () => {
      if (mode === 'hidden') document.dispatchEvent(new Event('visibilitychange'));
      else window.dispatchEvent(new Event('focus'));
    });
    expect(store.clear).toHaveBeenCalledWith('session');
  });

  it('does not read another session and switches its subscription on navigation', async () => {
    await act(async () => root.render(<View />));
    await act(async () => unread('other'));
    expect(store.clear).not.toHaveBeenCalled();
    await act(async () => root.render(<View id="other" />));
    expect(store.clear).toHaveBeenCalledWith('other');
    await act(async () => unread('session'));
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('discards queued acknowledgements after unmount', async () => {
    await act(async () => root.render(<View />));
    act(() => { unread(); root.unmount(); });
    await act(async () => {});
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.listeners.size).toBe(0);
  });

  it('does not let a queued callback acknowledge another device with the same session id', async () => {
    await act(async () => root.render(<View />));
    await act(async () => {
      unread();
      activateSurface('peer-read-on-open');
      // Before React commits the new surface, the previous callback must be invalid.
      await Promise.resolve();
      expect(store.clear).not.toHaveBeenCalled();
    });
    expect(store.clear).toHaveBeenCalledWith('session');
  });
});
