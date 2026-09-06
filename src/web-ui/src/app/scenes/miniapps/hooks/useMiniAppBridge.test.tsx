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
  type MiniAppDraftEventDetail,
  useMiniAppStore,
} from '../miniAppStore';
import { requestMiniAppComposerMessage } from '../miniAppComposerMessages';
import { useMiniAppBridge } from './useMiniAppBridge';

const mocks = vi.hoisted(() => ({
  activeTabId: 'miniapp:market-lens',
  peerModeActive: false,
  workspaceKind: undefined as 'remote' | undefined,
  agentEnsureSession: vi.fn(),
  agentRun: vi.fn(),
  getCustomizationMetadata: vi.fn(),
  loopxAttach: vi.fn(),
  loopxListModels: vi.fn(),
  loopxResolveIntake: vi.fn(),
  loopxCreateTask: vi.fn(),
  loopxAction: vi.fn(),
  loopxEventsSince: vi.fn(),
  loopxTurnOutputSince: vi.fn(),
  apiListen: vi.fn(),
  openMainSession: vi.fn(),
  addExternalSession: vi.fn(),
  loadSessionHistory: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({
  miniAppAPI: {
    agentEnsureSession: mocks.agentEnsureSession,
    agentRun: mocks.agentRun,
    getCustomizationMetadata: mocks.getCustomizationMetadata,
  },
}));

vi.mock('@/infrastructure/api/service-api/LoopxAPI', () => ({
  loopxAPI: {
    attach: mocks.loopxAttach,
    listModels: mocks.loopxListModels,
    resolveIntake: mocks.loopxResolveIntake,
    createTask: mocks.loopxCreateTask,
    action: mocks.loopxAction,
    eventsSince: mocks.loopxEventsSince,
    turnOutputSince: mocks.loopxTurnOutputSince,
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({
    workspacePath: '/repo',
    workspace: mocks.workspaceKind ? { workspaceKind: mocks.workspaceKind } : null,
  }),
}));

vi.mock('@/infrastructure/peer-device/peerModeFlag', () => ({
  isPeerDeviceModeActive: () => mocks.peerModeActive,
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
    getState: () => ({ sessions: new Map() }),
    addExternalSession: (...args: unknown[]) => mocks.addExternalSession(...args),
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
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
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

function ScopedBridgeHarness({
  appId,
  title,
  runScope,
  strictRuntime = true,
}: {
  appId: string;
  title: string;
  runScope: { kind: 'active'; appId: string } | { kind: 'draft'; appId: string; draftId: string };
  strictRuntime?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scopedApp = { ...app, id: appId, name: title } as MiniApp;
  useMiniAppBridge(iframeRef, scopedApp, runScope, strictRuntime);
  return <iframe ref={iframeRef} title={title} />;
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
    mocks.activeTabId = 'miniapp:market-lens';
    mocks.peerModeActive = false;
    mocks.workspaceKind = undefined;
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

  it('keeps Agent session ownership across a remount of the same runner scope', async () => {
    const appId = 'remount-agent-app';
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId={appId}
          title="Remount runner"
          runScope={{ kind: 'active', appId }}
        />,
      );
    });
    let iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await dispatchRpc(iframe, 1, 'agent.ensureSession', {
      sessionName: 'Remount runner',
      appDataWorkspace: 'chat',
    });

    await act(async () => {
      root.render(<></>);
    });
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId={appId}
          title="Remount runner"
          runScope={{ kind: 'active', appId }}
        />,
      );
    });
    iframe = container.querySelector('iframe') as HTMLIFrameElement;
    await dispatchRpc(iframe, 2, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Continue after remount',
    });

    expect(mocks.agentRun).toHaveBeenCalledTimes(1);
  });

  it('isolates Agent sessions between active and draft runners of the same app', async () => {
    const appId = 'scope-isolation-app';
    await act(async () => {
      root.render(
        <>
          <ScopedBridgeHarness
            appId={appId}
            title="Active runner"
            runScope={{ kind: 'active', appId }}
          />
          <ScopedBridgeHarness
            appId={appId}
            title="Draft runner"
            runScope={{ kind: 'draft', appId, draftId: 'draft-1' }}
          />
        </>,
      );
    });
    const [activeIframe, draftIframe] = [...container.querySelectorAll('iframe')];
    await dispatchRpc(activeIframe, 1, 'agent.ensureSession', {
      sessionName: 'Active runner',
      appDataWorkspace: 'chat',
    });
    await dispatchRpc(draftIframe, 2, 'agent.run', {
      sessionId: 'session-1',
      prompt: 'Must not cross runner scopes',
    });

    expect(mocks.agentRun).not.toHaveBeenCalled();
  });
});

describe('useMiniAppBridge LoopX controller routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.peerModeActive = false;
    mocks.workspaceKind = undefined;
    mocks.apiListen.mockImplementation(() => vi.fn());
    mocks.getCustomizationMetadata.mockResolvedValue({
      origin: {
        kind: 'builtin',
        builtin_id: 'builtin-bitfun-loopx',
        builtin_version: 1,
      },
      local_override: false,
      updated_at: 1,
    });
    mocks.loopxAttach.mockResolvedValue({
      snapshot: { streamId: 'stream-1', cursor: 0, revision: 1 },
    });
    mocks.loopxResolveIntake.mockResolvedValue({ preview: { fingerprint: 'preview-1' } });
    mocks.loopxCreateTask.mockResolvedValue({ outcomes: [], snapshotRevision: 2 });
    mocks.loopxAction.mockResolvedValue({ status: 'applied', currentRevision: 3 });
    mocks.loopxEventsSince.mockResolvedValue({
      status: 'current',
      streamId: 'stream-1',
      events: [],
      nextCursor: 4,
      hasMore: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('routes an active, non-strict verified builtin through the typed controller API', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;

    await dispatchRpc(iframe, 1, 'loopx.attach', {
      knownStreamId: 'stream-1',
      afterCursor: 4,
      resumeDetected: true,
    });

    expect(mocks.getCustomizationMetadata).toHaveBeenCalledWith('builtin-bitfun-loopx');
    expect(mocks.loopxAttach).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      knownStreamId: 'stream-1',
      afterCursor: 4,
      resumeDetected: true,
    });

    await dispatchRpc(iframe, 2, 'loopx.resolveIntake', {
      input: 'https://github.com/GCWing/BitFun/issues/2382',
      modelId: 'primary',
    });
    expect(mocks.loopxResolveIntake).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      input: 'https://github.com/GCWing/BitFun/issues/2382',
      modelId: 'primary',
    });

    const selectedItem = {
      repository: { host: 'github.com', owner: 'GCWing', repository: 'BitFun' },
      kind: 'issue',
      number: 2382,
    };
    await dispatchRpc(iframe, 3, 'loopx.createTask', {
      clientRequestId: 'request-1',
      previewFingerprint: 'preview-1',
      selectedItems: [selectedItem],
      modelId: 'primary',
      grantedScopes: ['workspace_read', 'agent_execution'],
      retryTerminal: false,
    });
    expect(mocks.loopxCreateTask).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      clientRequestId: 'request-1',
      previewFingerprint: 'preview-1',
      selectedItems: [selectedItem],
      modelId: 'primary',
      grantedScopes: ['workspace_read', 'agent_execution'],
      retryTerminal: false,
    });

    await dispatchRpc(iframe, 4, 'loopx.action', {
      taskId: 'task-1',
      action: 'pause',
      clientRequestId: 'request-2',
      expectedRevision: 2,
    });
    expect(mocks.loopxAction).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      taskId: 'task-1',
      action: 'pause',
      clientRequestId: 'request-2',
      expectedRevision: 2,
      gateId: undefined,
      note: undefined,
    });

    await dispatchRpc(iframe, 5, 'loopx.eventsSince', {
      streamId: 'stream-1',
      afterCursor: 4,
      limit: 50,
    });
    expect(mocks.loopxEventsSince).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      streamId: 'stream-1',
      afterCursor: 4,
      limit: 50,
    });

    await dispatchRpc(iframe, 6, 'loopx.turnOutputSince', {
      taskId: 'task-1',
      turnId: 'turn-1',
      streamId: 'stream-1',
      afterCursor: 9,
      limit: 25,
    });
    expect(mocks.loopxTurnOutputSince).toHaveBeenCalledWith('builtin-bitfun-loopx', {
      taskId: 'task-1',
      turnId: 'turn-1',
      streamId: 'stream-1',
      afterCursor: 9,
      limit: 25,
    });
  });

  it('forwards host controller events only after builtin metadata is verified', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="LoopX events"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
      await Promise.resolve();
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    const listenCall = mocks.apiListen.mock.calls.find(
      ([eventName]) => eventName === 'miniapp://loopx-event',
    );
    expect(listenCall).toBeDefined();
    const payload = {
      streamId: 'stream-1',
      cursor: 5,
      kind: 'progress',
      level: 'info',
      source: 'controller',
      message: 'Task is running',
    };

    act(() => {
      (listenCall?.[1] as (event: typeof payload) => void)(payload);
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'bitfun:event',
      event: 'loopx:event',
      payload,
    }, '*');
  });

  it('does not subscribe the local LoopX event stream while rendering a peer', async () => {
    mocks.peerModeActive = true;
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="Peer LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
      await Promise.resolve();
    });

    expect(mocks.apiListen.mock.calls.some(
      ([eventName]) => eventName === 'miniapp://loopx-event',
    )).toBe(false);
  });

  it('does not subscribe the local LoopX event stream for a remote workspace', async () => {
    mocks.workspaceKind = 'remote';
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="Remote workspace LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
      await Promise.resolve();
    });

    expect(mocks.apiListen.mock.calls.some(
      ([eventName]) => eventName === 'miniapp://loopx-event',
    )).toBe(false);
  });

  it('denies LoopX controller access from a draft preview', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="LoopX draft"
          runScope={{
            kind: 'draft',
            appId: 'builtin-bitfun-loopx',
            draftId: 'draft-1',
          }}
          strictRuntime={false}
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 2, 'loopx.attach');

    expect(mocks.getCustomizationMetadata).not.toHaveBeenCalled();
    expect(mocks.loopxAttach).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 2,
        error: expect.objectContaining({ message: expect.stringContaining('draft previews') }),
      }),
      '*',
    );
  });

  it('denies LoopX controller access to every other MiniApp id', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="user-loopx-copy"
          title="LoopX copy"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 3, 'loopx.attach');

    expect(mocks.getCustomizationMetadata).not.toHaveBeenCalled();
    expect(mocks.loopxAttach).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        error: expect.objectContaining({ message: expect.stringContaining('restricted') }),
      }),
      '*',
    );
  });

  it('denies LoopX controller access from a strict runtime', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="Strict LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 6, 'loopx.attach');

    expect(mocks.getCustomizationMetadata).not.toHaveBeenCalled();
    expect(mocks.loopxAttach).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 6,
        error: expect.objectContaining({ message: expect.stringContaining('strict') }),
      }),
      '*',
    );
  });

  it('denies a locally overridden builtin', async () => {
    mocks.getCustomizationMetadata.mockResolvedValue({
      origin: { kind: 'builtin', builtin_id: 'builtin-bitfun-loopx' },
      local_override: true,
      updated_at: 2,
    });
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="Overridden LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 4, 'loopx.attach');

    expect(mocks.loopxAttach).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 4,
        error: expect.objectContaining({ message: expect.stringContaining('local override') }),
      }),
      '*',
    );
  });

  it('rejects raw CLI arguments instead of forwarding them to the host', async () => {
    await act(async () => {
      root.render(
        <ScopedBridgeHarness
          appId="builtin-bitfun-loopx"
          title="LoopX"
          runScope={{ kind: 'active', appId: 'builtin-bitfun-loopx' }}
          strictRuntime={false}
        />,
      );
    });
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await dispatchRpc(iframe, 5, 'loopx.attach', {
      argv: ['loopx', '--registry', 'C:\\untrusted\\registry.json'],
    });

    expect(mocks.loopxAttach).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 5,
        error: expect.objectContaining({ message: expect.stringContaining('host-controlled') }),
      }),
      '*',
    );
  });
});
