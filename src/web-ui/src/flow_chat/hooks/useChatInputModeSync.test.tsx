/** @vitest-environment jsdom */
import { act, StrictMode, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialModeState, modeReducer } from '../reducers/modeReducer';
import type { Session } from '../types/flow-chat';
import { resolveChatInputSendAgentType } from '../utils/chatInputMode';
import { useChatInputModeSync } from './useChatInputModeSync';

const store = vi.hoisted(() => ({
  state: { sessions: new Map<string, Session>() },
  listeners: new Set<() => void>(),
  updateSessionMode: vi.fn(),
}));
vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => store.state,
    subscribe: (listener: () => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    updateSessionMode: store.updateSessionMode,
  },
}));

const modes = new Set(['Minimal', 'Standard', 'Ultimate', 'Claw']);
const renderedModes: string[] = [];
function Probe({ sessionId, assistant = false, available = modes, defaultMode = 'Standard' }: {
  sessionId: string | null;
  assistant?: boolean;
  available?: ReadonlySet<string>;
  defaultMode?: string;
}) {
  const [state, dispatchMode] = useReducer(modeReducer, initialModeState);
  useChatInputModeSync({ sessionId, currentMode: state.current, isAssistantWorkspace: assistant,
    userDefaultModeId: defaultMode, availableModeIds: available, dispatchMode });
  renderedModes.push(state.current);
  return <output>{state.current}</output>;
}

function session(id: string, mode: string, overrides: Partial<Session> = {}): Session {
  return { sessionId: id, mode, config: { agentType: mode }, lastSubmittedMode: mode, ...overrides } as Session;
}

describe('useChatInputModeSync', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    store.state = { sessions: new Map() };
    store.updateSessionMode.mockClear();
    renderedModes.length = 0;
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(store.listeners.size).toBe(0);
    expect(store.updateSessionMode).not.toHaveBeenCalled();
  });
  const render = (props: Parameters<typeof Probe>[0]) => act(async () => {
    root.render(<StrictMode><Probe {...props} /></StrictMode>);
  });
  const notify = () => act(() => store.listeners.forEach(listener => listener()));

  it('switches from Claw to a newly restored Minimal session without publishing Standard', async () => {
    store.state.sessions.set('assistant', session('assistant', 'Claw'));
    await render({ sessionId: 'assistant', assistant: true });
    expect(container.textContent).toBe('Claw');

    // The target reaches the live store before the composer's old session
    // snapshot. Changing the selected id must read the new binding immediately.
    const restored = session('project', 'Minimal');
    store.state = { sessions: new Map([...store.state.sessions, ['project', restored]]) };
    renderedModes.length = 0;
    await render({ sessionId: 'project' });
    expect(container.textContent).toBe('Minimal');
    expect(renderedModes).not.toContain('Standard');
    expect(store.state.sessions.get('project')).toBe(restored);
    expect(restored.mode).toBe('Minimal');
    expect(resolveChatInputSendAgentType({ isSubagentTarget: false,
      composerMode: container.textContent!, sessionMode: restored.mode })).toBe(restored.lastSubmittedMode);

    await render({ sessionId: 'assistant', assistant: true });
    await render({ sessionId: 'project' });
    expect(container.textContent).toBe('Minimal');
  });

  it('waits for a selected remote session and restores its binding before the catalog arrives', async () => {
    store.state.sessions.set('assistant', session('assistant', 'Claw'));
    await render({ sessionId: 'assistant', assistant: true });
    await render({ sessionId: 'remote', defaultMode: 'Standard' });
    expect(container.textContent).toBe('Claw');

    await render({ sessionId: 'remote', available: new Set() });
    store.state.sessions.set('remote', session('remote', 'Minimal', {
      remoteConnectionId: 'ssh-fixture', workspacePath: '/srv/project',
    }));
    notify();
    expect(container.textContent).toBe('Minimal');
    await render({ sessionId: 'remote', available: new Set(['Standard']) });
    expect(container.textContent).toBe('Minimal');
  });

  it('reads the selected device surface even when the session id is unchanged', async () => {
    const local = session('same-id', 'Standard');
    const peer = session('same-id', 'Minimal');
    store.state = { sessions: new Map([['same-id', local]]) };
    await render({ sessionId: 'same-id' });
    store.state = { sessions: new Map([['same-id', peer]]) };
    notify();
    expect(container.textContent).toBe('Minimal');
    expect(local.mode).toBe('Standard');
    expect(peer.mode).toBe('Minimal');
  });

  it('keeps default selection for a composer without a session', async () => {
    await render({ sessionId: null, defaultMode: 'Ultimate' });
    expect(container.textContent).toBe('Ultimate');
  });

  it.each(['acp:codex', 'OpenBitFun', 'PlannerPlus'])('retains the saved %s binding outside the catalog', async mode => {
    store.state.sessions.set('saved', session('saved', mode));
    await render({ sessionId: 'saved', available: new Set() });
    expect(container.textContent).toBe(mode);
  });
});
