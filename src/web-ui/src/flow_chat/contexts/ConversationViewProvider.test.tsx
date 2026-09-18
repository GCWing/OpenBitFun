/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import { ConversationViewProvider } from './ConversationViewProvider';
import { useActiveSession } from '../store/modernFlowChatStore';
import { useContextStoreApi } from '@/shared/stores/contextStore';
import { useChatInputState } from '../store/chatInputStateStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = vi.hoisted(() => ({
  state: { sessions: new Map<string, Session>(), activeSessionId: 'main' },
  listeners: new Set<() => void>(),
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => source.state,
  subscribe: (listener: () => void) => { source.listeners.add(listener); return () => source.listeners.delete(listener); },
} }));

describe('concurrent conversation views', () => {
  it('isolates selection, attachments and composer geometry while observing the same runtime records', async () => {
    const session = (sessionId: string) => ({ sessionId, dialogTurns: [], config: {}, todos: [] } as unknown as Session);
    source.state.sessions = new Map([['main', session('main')], ['float', session('float')]]);
    const seen = new Map<string, { session: Session | null; contexts: ReturnType<typeof useContextStoreApi>; height: number; setHeight: (height: number) => void }>();
    function Probe({ id }: { id: string }) {
      const active = useActiveSession();
      const contexts = useContextStoreApi();
      const height = useChatInputState(s => s.inputHeight);
      const setHeight = useChatInputState(s => s.setInputHeight);
      seen.set(id, { session: active, contexts, height, setHeight });
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<>
      <ConversationViewProvider scope={{ surfaceId: 'local', sessionId: 'main', viewId: 'main', presentation: 'standard' }}><Probe id="main" /></ConversationViewProvider>
      <ConversationViewProvider scope={{ surfaceId: 'local', sessionId: 'float', viewId: 'float', presentation: 'compact' }}><Probe id="float" /></ConversationViewProvider>
    </>));
    const originalHeight = seen.get('main')!.height;
    await act(async () => {
      seen.get('float')!.setHeight(originalHeight + 100);
      seen.get('float')!.contexts.getState().addContext({ id: 'float-file', type: 'file', name: 'own.ts', path: '/own.ts' } as never);
      source.state = { ...source.state, activeSessionId: 'another', sessions: new Map(source.state.sessions) };
      source.state.sessions.set('float', { ...source.state.sessions.get('float')!, title: 'Updated by Runtime' });
      source.listeners.forEach(listener => listener());
    });
    expect(seen.get('main')!.session?.sessionId).toBe('main');
    expect(seen.get('float')!.session).toBe(source.state.sessions.get('float'));
    expect(seen.get('main')!.height).toBe(originalHeight);
    expect(seen.get('main')!.contexts.getState().contexts).toEqual([]);
    expect(seen.get('float')!.contexts.getState().contexts).toHaveLength(1);
    expect(source.state.activeSessionId).toBe('another');
    await act(async () => root.unmount());
    expect(source.listeners.size).toBe(0);
  });
});
