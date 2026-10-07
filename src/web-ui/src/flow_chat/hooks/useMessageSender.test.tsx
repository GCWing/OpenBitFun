/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMessageSender } from './useMessageSender';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => {
  const createChatSession = vi.fn();
  const sendMessage = vi.fn();
  const sessions = new Map<string, Record<string, unknown>>();
  const ensureBackendSession = vi.fn();
  const sendBtw = vi.fn();
  const manager = {
    createChatDraft: createChatSession,
    sendMessage,
    getFlowChatState: () => ({ sessions }),
    ensureBackendSession,
  };

  return {
    createChatSession,
    sendMessage,
    manager,
    sessions, ensureBackendSession, sendBtw,
    peerActive: false,
    initialBtwModelSupported: false,
    onClearContexts: vi.fn(),
  };
});

vi.mock('../services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => mocks.manager,
  },
}));

vi.mock('../services/BtwThreadService', () => ({ sendMessageToBtwSession: mocks.sendBtw }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({
    peerMode: { active: mocks.peerActive },
    currentPeerCapabilities: { btwInitialModelSelectionV1: mocks.initialBtwModelSupported },
  }),
}));

vi.mock('@/app/utils/projectSessionWorkspace', () => ({
  flowChatSessionConfigForCurrentWorkspace: () => ({ workspacePath: '/workspace/project' }),
}));

vi.mock('../utils/imagePayload', () => ({
  buildImagePayload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: { error: vi.fn() },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

let sendFromProbe: (() => Promise<void>) | undefined;
let sendDraftFromProbe: (() => Promise<void>) | undefined;
let sendWithClearedComposerFromProbe: (() => Promise<void>) | undefined;

function Probe() {
  const { sendMessage } = useMessageSender({
    contexts: [],
    onClearContexts: mocks.onClearContexts,
  });
  sendFromProbe = () => sendMessage('hello');
  sendDraftFromProbe = () => sendMessage('expanded paste content', {
    displayMessage: '[Pasted text #1]',
    composerDraft: {
      value: '[Pasted text #1]',
      pendingLargePastes: { '[Pasted text #1]': 'expanded paste content' },
    },
  });
  sendWithClearedComposerFromProbe = () => sendMessage('image prompt', {
    clearContextsOnSuccess: false,
  });
  return null;
}

const excerpt: ConversationExcerptContext = {
  id: 'quote-1', type: 'conversation-excerpt', timestamp: 1,
  source: { surfaceId: 'local', sessionId: 'parent', sessionName: 'Parent' },
  fragments: [{ turnId: 'turn-1', text: 'Quoted content', start: 0, end: 14, prefix: '', suffix: '' }],
  comment: 'Explain the assumption',
};
function ExcerptProbe({ sessionId }: { sessionId: string }) {
  const sender = useMessageSender({ contexts: [excerpt], currentSessionId: sessionId, onClearContexts: mocks.onClearContexts });
  sendFromProbe = () => sender.sendMessage('Why?', { composerDraft: { value: 'Why?', pendingLargePastes: {} } });
  return null;
}

describe('useMessageSender', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.createChatSession.mockResolvedValue('created-session');
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.sessions.clear();
    mocks.peerActive = false;
    mocks.initialBtwModelSupported = false;
    mocks.sessions.set('created-session', { mode: 'Standard' });
    mocks.ensureBackendSession.mockResolvedValue(undefined);
    mocks.sendBtw.mockResolvedValue({ requestId: 'request-1' });
    activateSurface('local');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sendFromProbe = undefined;
    sendDraftFromProbe = undefined;
    sendWithClearedComposerFromProbe = undefined;
    vi.clearAllMocks();
  });

  it('creates a Session with the selected Agent type and no Harness overlay', async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await sendFromProbe?.();
    });

    expect(mocks.createChatSession).toHaveBeenCalledWith(
      {
        workspacePath: '/workspace/project',
      },
      'Standard',
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      'created-session',
      'hello',
      'Standard',
      undefined,
      expect.objectContaining({
        pendingQueueDraft: {
          value: 'hello',
          contexts: [],
          pendingLargePastes: {},
        },
      }),
    );
    expect(mocks.onClearContexts).toHaveBeenCalledOnce();
  });

  it('preserves the original large-paste composer draft for queued restoration', async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await sendDraftFromProbe?.();
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'expanded paste content',
      'created-session',
      '[Pasted text #1]',
      'Standard',
      undefined,
      expect.objectContaining({
        pendingQueueDraft: {
          value: '[Pasted text #1]',
          contexts: [],
          pendingLargePastes: { '[Pasted text #1]': 'expanded paste content' },
        },
      }),
    );
  });

  it('skips delayed context cleanup when the caller already cleared the submission', async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await sendWithClearedComposerFromProbe?.();
    });

    expect(mocks.onClearContexts).not.toHaveBeenCalled();
  });

  it('keeps a readable quote fallback and the full queued composer context', async () => {
    await act(async () => root.render(<ExcerptProbe sessionId="created-session" />));
    await act(async () => sendFromProbe?.());
    const [prompt, , display, , , options] = mocks.sendMessage.mock.calls[0];
    expect(prompt).toContain('Quoted content');
    expect(prompt).toContain('User annotation: Explain the assumption');
    expect(display).toContain('Quoted content');
    expect(options.pendingQueueDraft.contexts).toEqual([excerpt]);
    expect(options.userMessageMetadata.composerPresentation.segments).toContainEqual(expect.objectContaining({ context: excerpt }));
  });

  it('uses the parent snapshot path for the first side message and the normal path for follow-ups', async () => {
    mocks.sessions.set('side', { sessionId: 'side', sessionKind: 'btw', parentSessionId: 'parent',
      dialogTurns: [], config: { modelName: 'parent-model', reasoningPreset: 'high' }, btwOrigin: { requestId: 'request-1' } });
    await act(async () => root.render(<ExcerptProbe sessionId="side" />));
    await act(async () => sendFromProbe?.());
    expect(mocks.ensureBackendSession).toHaveBeenCalledWith('parent');
    expect(mocks.sendBtw).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'parent', childSessionId: 'side',
      requestId: 'request-1', modelId: 'parent-model', question: expect.stringContaining('Quoted content'),
      userMessageMetadata: expect.objectContaining({ composerPresentation: expect.any(Object) }),
      initialModelSelection: { modelId: 'parent-model', reasoningPreset: 'high' },
    }));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    mocks.sessions.get('side')!.dialogTurns = [{ id: 'first-turn' }];
    await act(async () => sendFromProbe?.());
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendBtw).toHaveBeenCalledOnce();
  });

  it.each([false, true])('negotiates initial side model settings on a peer: %s', async supported => {
    mocks.peerActive = true;
    mocks.initialBtwModelSupported = supported;
    mocks.sessions.set('side', { sessionId: 'side', sessionKind: 'btw', parentSessionId: 'parent',
      dialogTurns: [], config: { modelName: 'parent-model' } });
    await act(async () => root.render(<ExcerptProbe sessionId="side" />));
    await act(async () => sendFromProbe?.());
    const request = mocks.sendBtw.mock.calls[0][0];
    if (supported) expect(request.initialModelSelection).toEqual({ modelId: 'parent-model', reasoningPreset: undefined });
    else expect(request).not.toHaveProperty('initialModelSelection');
    expect(request.question).toContain('Quoted content');
  });

  it('propagates a first-send failure for draft recovery and fences sends after a surface switch', async () => {
    mocks.sessions.set('side', { sessionId: 'side', sessionKind: 'btw', parentSessionId: 'parent', dialogTurns: [], config: {} });
    mocks.sendBtw.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<ExcerptProbe sessionId="side" />));
    await act(async () => { await expect(sendFromProbe!()).rejects.toThrow('offline'); });
    expect(mocks.onClearContexts).not.toHaveBeenCalled();
    mocks.sendBtw.mockClear();
    mocks.ensureBackendSession.mockImplementationOnce(async () => { activateSurface('peer'); });
    await act(async () => { await expect(sendFromProbe!()).rejects.toThrow('Device surface changed'); });
    expect(mocks.sendBtw).not.toHaveBeenCalled();
    expect(mocks.onClearContexts).not.toHaveBeenCalled();
  });
});
