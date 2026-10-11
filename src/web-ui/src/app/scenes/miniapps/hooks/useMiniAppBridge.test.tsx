/**
 * @vitest-environment jsdom
 */

import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MiniApp } from '@/infrastructure/api/service-api/MiniAppAPI';
import {
  MINIAPP_COMPOSER_DRAFT_EVENT,
  MINIAPP_COMPOSER_FOCUS_EVENT,
  type MiniAppFocusEventDetail,
  type MiniAppDraftEventDetail,
  useMiniAppStore,
} from '../miniAppStore';
import { requestMiniAppComposerMessage } from '../miniAppComposerMessages';
import { useMiniAppBridge } from './useMiniAppBridge';

const mocks = vi.hoisted(() => ({
  activeTabId: 'miniapp:market-lens',
  agentEnsureSession: vi.fn(),
  agentRun: vi.fn(),
  apiListen: vi.fn(),
  openMainSession: vi.fn(),
  addExternalSession: vi.fn(),
  loadSessionHistory: vi.fn(),
  registeredSessions: new Map(),
}));

vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({
  miniAppAPI: {
    agentEnsureSession: mocks.agentEnsureSession,
    agentRun: mocks.agentRun,
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspacePath: '/repo' }),
}));

vi.mock('@/infrastructure/theme/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

vi.mock('../utils/buildMiniAppThemeVars', () => ({
  buildMiniAppThemeVars: () => ({}),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    listen: (...args: unknown[]) => mocks.apiListen(...args),
    invoke: vi.fn(),
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ currentLanguage: 'en-US' }),
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: {},
}));

vi.mock('@/infrastructure/api', () => ({
  workspaceAPI: {},
}));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: mocks.registeredSessions }),
    addExternalSession: (...args: unknown[]) => {
      mocks.registeredSessions.set(args[0], {});
      return mocks.addExternalSession(...args);
    },
    loadSessionHistory: (...args: unknown[]) => mocks.loadSessionHistory(...args),
  },
}));

vi.mock('@/flow_chat/services/sessionActivation', () => ({
  openMainSession: (...args: unknown[]) => mocks.openMainSession(...args),
}));

vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: {
    getState: () => ({ activeTabId: mocks.activeTabId }),
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const app = {
  id: 'market-lens',
  name: 'Market Lens',
  permissions: {
    node: { enabled: false },
    agent: { enabled: true },
    host: { chat_composer: true },
  },
} as unknown as MiniApp;

function BridgeHarness() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  useMiniAppBridge(
    iframeRef,
    app,
    { kind: 'active', appId: app.id },
    true,
  );
  return <iframe ref={iframeRef} title="Market Lens test" />;
}

async function dispatchRpc(
  iframe: HTMLIFrameElement,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { jsonrpc: '2.0', id, method, params },
      source: iframe.contentWindow,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe('useMiniAppBridge floating Agent routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.registeredSessions.clear();
    mocks.activeTabId = 'miniapp:market-lens';
    mocks.agentEnsureSession.mockResolvedValue({
      sessionId: 'session-1',
      created: true,
      workspacePath: '/repo',
    });
    mocks.agentRun.mockResolvedValue({ sessionId: 'session-1' });
    mocks.openMainSession.mockResolvedValue(undefined);
    mocks.apiListen.mockImplementation(() => vi.fn());
    useMiniAppStore.setState({ composerClaims: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useMiniAppStore.setState({ composerClaims: {} });
    vi.clearAllMocks();
  });

  it('keeps a claimed and bound strict Agent run in the floating bubble', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', {
      sessionName: 'Market Lens',
      appDataWorkspace: 'chat',
    });

    expect(mocks.agentEnsureSession).toHaveBeenCalledTimes(1);
    expect(mocks.openMainSession).not.toHaveBeenCalled();

    await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'session-1' });
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBe('session-1');

    await dispatchRpc(iframe, 4, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Summarize the market',
      displayText: 'Summarize the market',
      appDataWorkspace: 'chat',
      contextFiles: [{ name: 'stocks.ndjson', content: '{"code":"688256"}\n' }],
    });

    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
    expect(mocks.agentRun.mock.calls[0][3].contextFiles).toEqual([
      { name: 'stocks.ndjson', content: '{"code":"688256"}\n' },
    ]);
    expect(mocks.openMainSession).not.toHaveBeenCalled();
  });

  it('requests navigation again when the already bound session is focused', async () => {
    await act(async () => { root.render(<BridgeHarness />); });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', { appDataWorkspace: 'chat' });
    const requests: MiniAppFocusEventDetail[] = [];
    const record = (event: Event) => { requests.push((event as CustomEvent<MiniAppFocusEventDetail>).detail); };
    window.addEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, record);
    try {
      await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'session-1' });
      await dispatchRpc(iframe, 4, 'chat.focusSession', { sessionId: 'session-1' });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]).toMatchObject({ appId: app.id, sessionId: 'session-1', surfaceId: 'local' });
      expect(mocks.agentEnsureSession).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, record); }
  });

  it('rejects malformed Agent context files instead of dropping them', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'agent.ensureSession', {
      sessionName: 'Market Lens',
      appDataWorkspace: 'chat',
    });
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 2, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Summarize the market',
      contextFiles: '{"not":"an array"}',
    });

    expect(mocks.agentRun).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'agent.run: contextFiles must be an array when provided.',
        }),
      }),
      '*',
    );
  });

  it('associates a composer draft with the session focused immediately before it', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const drafts: MiniAppDraftEventDetail[] = [];
    const onDraft = (event: Event) => {
      drafts.push((event as CustomEvent<MiniAppDraftEventDetail>).detail);
    };
    window.addEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, onDraft);

    try {
      await dispatchRpc(iframe, 1, 'chat.claimComposer');
      await dispatchRpc(iframe, 2, 'agent.ensureSession', {
        sessionName: 'Market Lens',
        appDataWorkspace: 'chat',
      });
      await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'session-1' });
      await dispatchRpc(iframe, 4, 'chat.setComposerDraft', {
        text: 'Analyze 920130',
      });
    } finally {
      window.removeEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, onDraft);
    }

    expect(drafts).toEqual([{
      token: expect.any(String),
      text: 'Analyze 920130',
      sessionId: 'session-1',
    }]);
  });

  it('forwards a voice request and settles it only after the owning iframe acknowledges it', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 11, 'agent.ensureSession', { appDataWorkspace: 'chat' });
    await dispatchRpc(iframe, 12, 'chat.focusSession', { sessionId: 'session-1' });
    const token = useMiniAppStore.getState().composerClaims[app.id]?.token;
    expect(token).toEqual(expect.any(String));
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const completion = requestMiniAppComposerMessage({
      token: token!,
      source: 'realtime_voice',
      text: 'Analyze the latest numbers',
      sessionId: 'session-1',
    });
    const requestEvent = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(message => message.event === 'chat:userMessage') as {
        payload: { requestId: string; source: string };
      } | undefined;
    expect(requestEvent?.payload).toMatchObject({
      requestId: expect.any(String),
      source: 'realtime_voice',
    });

    let settled = false;
    void completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await dispatchRpc(iframe, 2, 'chat.completeUserMessage', {
      requestId: requestEvent!.payload.requestId,
    });
    await expect(completion).resolves.toBeUndefined();
  });

  it('refuses to bind the bubble to a session the MiniApp did not create', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'chat.focusSession', {
      sessionId: 'normal-user-session',
    });

    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBeUndefined();
  });

  it('creates and switches between topic sessions without reusing the prior workspace', async () => {
    await act(async () => { root.render(<BridgeHarness />); });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    mocks.agentEnsureSession
      .mockResolvedValueOnce({ sessionId: 'deck-one', created: true, workspacePath: '/app/decks/one' })
      .mockResolvedValueOnce({ sessionId: 'deck-two', created: true, workspacePath: '/app/decks/two' });
    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', { appDataWorkspace: 'decks/one' });
    await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'deck-one' });
    await dispatchRpc(iframe, 4, 'chat.clearSession');
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBeUndefined();
    await dispatchRpc(iframe, 5, 'agent.ensureSession', { appDataWorkspace: 'decks/two' });
    await dispatchRpc(iframe, 6, 'chat.focusSession', { sessionId: 'deck-two' });
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBe('deck-two');
    await dispatchRpc(iframe, 7, 'chat.focusSession', { sessionId: 'deck-one' });
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBe('deck-one');
    expect(mocks.registeredSessions.size).toBe(2);
    expect(mocks.agentEnsureSession.mock.calls.map(call => call[1].sessionId)).toEqual([undefined, undefined]);
  });

  it('reports history loading failures and retries restoration of the same registered session', async () => {
    await act(async () => { root.render(<BridgeHarness />); });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    mocks.agentEnsureSession.mockResolvedValue({ sessionId: 'saved', created: false, workspacePath: '/app/chat' });
    mocks.loadSessionHistory.mockRejectedValueOnce(new Error('Peer disconnected')).mockResolvedValueOnce(undefined);
    await dispatchRpc(iframe, 1, 'agent.ensureSession', { sessionId: 'saved', appDataWorkspace: 'chat' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, error: expect.anything() }), '*');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', { sessionId: 'saved', appDataWorkspace: 'chat' });
    expect(mocks.addExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.loadSessionHistory).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 2, result: expect.objectContaining({ sessionId: 'saved' }) }), '*');
  });

  it('restores the exact saved topic only after its hidden history has loaded', async () => {
    await act(async () => { root.render(<BridgeHarness />); });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    mocks.registeredSessions.set('latest-chat', {});
    mocks.agentEnsureSession.mockResolvedValue({ sessionId: 'saved-topic', created: false, workspacePath: '/app/decks/saved' });
    let finishHistory = () => {};
    const history = new Promise<void>((resolve) => { finishHistory = resolve; });
    mocks.loadSessionHistory.mockReturnValueOnce(history);

    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', { sessionId: 'saved-topic', appDataWorkspace: 'decks/saved' });
    expect(mocks.loadSessionHistory).toHaveBeenCalledWith('saved-topic', { includeInternal: true });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), '*');
    await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'saved-topic' });
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBeUndefined();

    await act(async () => { finishHistory(); await history; });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 2, result: expect.objectContaining({ sessionId: 'saved-topic' }) }), '*');
    await dispatchRpc(iframe, 4, 'chat.focusSession', { sessionId: 'saved-topic' });
    expect(useMiniAppStore.getState().composerClaims[app.id]?.sessionId).toBe('saved-topic');
    await dispatchRpc(iframe, 5, 'agent.ensureSession', { sessionId: 'saved-topic', appDataWorkspace: 'decks/saved' });
    expect(mocks.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(mocks.openMainSession).not.toHaveBeenCalled();
  });

  it('rejects an old-topic message before it reaches the new topic in the iframe', async () => {
    await act(async () => { root.render(<BridgeHarness />); });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', { appDataWorkspace: 'chat' });
    await dispatchRpc(iframe, 3, 'chat.focusSession', { sessionId: 'session-1' });
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    const claim = useMiniAppStore.getState().composerClaims[app.id];
    await expect(requestMiniAppComposerMessage({
      token: claim.token, text: 'Old topic question', sessionId: 'old-session',
    })).rejects.toThrow('conversation changed');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('opens an unbound strict Agent run in the main session scene', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'chat.claimComposer');
    await dispatchRpc(iframe, 2, 'agent.ensureSession', {
      sessionName: 'Market Lens',
      appDataWorkspace: 'chat',
    });
    await dispatchRpc(iframe, 3, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Summarize the market',
    });

    expect(mocks.openMainSession).toHaveBeenCalledWith('session-1');
    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
  });

  it('leaves the tool loop of a strict Agent run to the backend allowlist', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'agent.ensureSession', {
      sessionName: 'Market Lens',
      appDataWorkspace: 'chat',
    });
    await dispatchRpc(iframe, 2, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Summarize the market',
    });

    // The host used to force enableTools=false for marketplace MiniApps, which
    // also killed WebSearch/WebFetch. Tool access is now scoped by the backend
    // research allowlist instead, so the bridge must not disable the loop.
    expect(mocks.agentEnsureSession.mock.calls[0][1].enableTools).toBeUndefined();
    expect(mocks.agentRun.mock.calls[0][3].enableTools).toBeUndefined();
  });
});
