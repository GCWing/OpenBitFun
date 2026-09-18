import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateSession = vi.fn();
const mockAskStream = vi.fn();
const mockAddExternalSession = vi.fn();
const mockUpdateSessionRelationship = vi.fn();
const mockUpdateSessionBtwOrigin = vi.fn();
const mockAddBtwThreadMarker = vi.fn();
const mockUpdateSessionModelName = vi.fn();
const mockUpdateSessionReasoningPreset = vi.fn();
const mockEnsureBackendSession = vi.fn();

const sessions = new Map<string, any>();

vi.mock('@/infrastructure/api', () => ({
  agentAPI: {
    createSession: (...args: any[]) => mockCreateSession(...args),
  },
  btwAPI: {
    askStream: (...args: any[]) => mockAskStream(...args),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions }),
    addExternalSession: (...args: any[]) => mockAddExternalSession(...args),
    updateSessionRelationship: (...args: any[]) => mockUpdateSessionRelationship(...args),
    updateSessionBtwOrigin: (...args: any[]) => mockUpdateSessionBtwOrigin(...args),
    addBtwThreadMarker: (...args: any[]) => mockAddBtwThreadMarker(...args),
    updateSessionModelName: (...args: any[]) => mockUpdateSessionModelName(...args),
    updateSessionReasoningPreset: (...args: any[]) => mockUpdateSessionReasoningPreset(...args),
  },
}));

vi.mock('../state-machine', () => ({
  stateMachineManager: {
    get: () => ({
      getContext: () => ({
        currentDialogTurnId: 'turn-parent-1',
      }),
    }),
  },
}));

vi.mock('./FlowChatManager', () => ({
  flowChatManager: {
    discardLocalSession: vi.fn(),
    ensureBackendSession: (...args: any[]) => mockEnsureBackendSession(...args),
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    warning: vi.fn(),
  },
}));

import {
  createBtwChildSession,
  createBtwSessionPlaceholder,
  sendMessageToBtwSession,
  startBtwThread,
} from './BtwThreadService';

describe('BtwThreadService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
    sessions.set('parent-1', {
      sessionId: 'parent-1',
      mode: 'Standard',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
      config: {
        modelName: 'primary',
        reasoningPreset: 'high',
      },
      dialogTurns: [
        {
          id: 'turn-parent-1',
        },
      ],
    });
    mockAskStream.mockResolvedValue({ ok: true });
    mockCreateSession.mockResolvedValue({
      sessionId: 'child-1',
    });
  });

  it('passes structured relationship metadata to backend-created review sessions', async () => {
    const deepReviewRunManifest = {
      reviewers: [],
    };

    await createBtwChildSession({
      parentSessionId: 'parent-1',
      workspacePath: '/workspace',
      childSessionName: 'Deep review',
      sessionKind: 'deep_review',
      agentType: 'DeepReview',
      requestId: 'review-request-1',
      deepReviewRunManifest,
    });

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'Deep review',
        agentType: 'DeepReview',
        sessionId: 'review_child_review-request-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        remoteConnectionId: 'remote-1',
        remoteSshHost: 'host-1',
        relationship: {
          kind: 'deep_review',
          parentSessionId: 'parent-1',
          parentRequestId: 'review-request-1',
          parentDialogTurnId: 'turn-parent-1',
          parentTurnIndex: 1,
        },
        deepReviewRunManifest,
      }),
    );
  });

  it('persists the narrow target envelope for standard review follow-up turns', async () => {
    const reviewTargetEvidence = {
      version: 1 as const,
      source: 'workspace' as const,
      fingerprint: '0123456789abcdef',
      completeness: 'partial' as const,
      workspaceBinding: 'matching_dirty' as const,
      files: [],
      limitations: ['mutable_workspace_snapshot'],
    };

    await createBtwChildSession({
      parentSessionId: 'parent-1',
      workspacePath: '/workspace',
      childSessionName: 'Review',
      sessionKind: 'review',
      agentType: 'CodeReview',
      requestId: 'review-target-1',
      reviewTargetEvidence,
    });

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      reviewTargetEvidence,
    }));
  });

  it('creates a durable /btw placeholder with its parent anchor', () => {
    const result = createBtwSessionPlaceholder({
      parentSessionId: 'parent-1',
      workspacePath: '/workspace',
      childSessionName: 'Side question',
    });

    expect(result.childSessionId).toMatch(/^btw_session_/);
    expect(result.parentDialogTurnId).toBe('turn-parent-1');
    expect(result.parentTurnIndex).toBe(1);
    expect(mockAddExternalSession).toHaveBeenCalledWith(
      result.childSessionId,
      'Side question',
      'Standard',
      '/workspace',
      expect.objectContaining({
        parentSessionId: 'parent-1',
        sessionKind: 'btw',
        isTransient: false,
        btwOrigin: {
          parentSessionId: 'parent-1',
          parentDialogTurnId: 'turn-parent-1',
          parentTurnIndex: 1,
        },
      }),
      'remote-1',
      'host-1',
    );
    expect(mockUpdateSessionRelationship).toHaveBeenCalledWith(result.childSessionId, {
      parentSessionId: 'parent-1',
      sessionKind: 'btw',
    });
  });

  it('stores an absolute parent Turn index for a partial restored tail', () => {
    sessions.set('parent-1', {
      ...sessions.get('parent-1'),
      isPartial: true,
      loadedTurnCount: 3,
      totalTurnCount: 100,
      dialogTurns: [
        { id: 'turn-98' },
        { id: 'turn-99' },
        { id: 'turn-parent-1' },
      ],
    });

    const result = createBtwSessionPlaceholder({
      parentSessionId: 'parent-1',
      workspacePath: '/workspace',
      childSessionName: 'Side question',
    });

    expect(result.parentDialogTurnId).toBe('turn-parent-1');
    expect(result.parentTurnIndex).toBe(100);
  });

  it('anchors a selected historical Turn and inherits the parent model', () => {
    sessions.get('parent-1').dialogTurns.unshift({ id: 'selected-turn' });
    const result = createBtwSessionPlaceholder({ parentSessionId: 'parent-1',
      childSessionName: 'Side question', parentDialogTurnId: 'selected-turn' });
    expect(result.parentDialogTurnId).toBe('selected-turn');
    expect(result.parentTurnIndex).toBe(1);
    expect(mockUpdateSessionModelName).toHaveBeenCalledWith(result.childSessionId, 'primary');
    expect(mockUpdateSessionReasoningPreset).toHaveBeenCalledWith(result.childSessionId, 'high');
    expect(mockUpdateSessionModelName).toHaveBeenCalledWith(result.childSessionId, 'primary');
  });

  it('retains quote metadata and stable request identity on a failed initial submission retry', async () => {
    sessions.set('btw-child', {
      sessionId: 'btw-child', title: 'Side question', sessionKind: 'btw',
      btwOrigin: { parentDialogTurnId: 'selected-turn' }, config: {},
    });
    const userMessageMetadata = { composerPresentation: { version: 1, segments: [{ kind: 'text', text: 'quote' }] },
      sessionReferences: [{ sessionId: 'reference' }] };
    const params = { parentSessionId: 'parent-1', childSessionId: 'btw-child', question: 'Quote and question',
      requestId: 'stable-request', userMessageMetadata,
      initialModelSelection: { modelId: 'primary', reasoningPreset: 'high' } };
    mockAskStream.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(sendMessageToBtwSession(params)).rejects.toThrow('network unavailable');
    await sendMessageToBtwSession(params);
    expect(mockAskStream).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: 'stable-request', question: 'Quote and question', userMessageMetadata, parentDialogTurnId: 'selected-turn',
      initialModelSelection: { modelId: 'primary', reasoningPreset: 'high' },
    }));
    expect(sessions.has('btw-child')).toBe(true);
  });

  it('passes image contexts and parent turn metadata through to the desktop /btw API', async () => {
    sessions.set('btw-child', {
      sessionId: 'btw-child',
      title: 'Side question',
      isTransient: false,
      sessionKind: 'btw',
      config: { modelName: 'fast' },
      btwOrigin: {
        parentSessionId: 'parent-1',
        parentDialogTurnId: 'turn-parent-1',
        parentTurnIndex: 1,
      },
    });

    await sendMessageToBtwSession({
      parentSessionId: 'parent-1',
      childSessionId: 'btw-child',
      question: 'What is in this image?',
      imagePayload: {
        imageContexts: [
          {
            id: 'img-1',
            image_path: 'C:/tmp/clip.png',
            mime_type: 'image/png',
            metadata: { name: 'clip.png' },
          },
        ],
        imageDisplayData: [
          {
            id: 'img-1',
            name: 'clip.png',
            imagePath: 'C:/tmp/clip.png',
            mimeType: 'image/png',
          },
        ],
      },
    });

    expect(mockAskStream).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'parent-1',
        childSessionId: 'btw-child',
        question: 'What is in this image?',
        parentDialogTurnId: 'turn-parent-1',
        parentTurnIndex: 1,
        imageContexts: [
          expect.objectContaining({
            id: 'img-1',
            image_path: 'C:/tmp/clip.png',
            mime_type: 'image/png',
          }),
        ],
      }),
    );
    expect(mockAskStream.mock.calls[0][0]).not.toHaveProperty('modelId');
    expect(mockUpdateSessionBtwOrigin).toHaveBeenCalledWith(
      'btw-child',
      expect.objectContaining({
        requestId: expect.any(String),
        parentSessionId: 'parent-1',
        parentDialogTurnId: 'turn-parent-1',
        parentTurnIndex: 1,
      }),
      'btw',
    );
  });

  it('discards the local placeholder when the first /btw request fails', async () => {
    const error = new Error('backend refused');
    mockAskStream.mockRejectedValueOnce(error);
    mockAddExternalSession.mockImplementationOnce((sessionId, title, mode, workspacePath, meta) => {
      sessions.set(sessionId, {
        sessionId,
        title,
        mode,
        workspacePath,
        config: {},
        sessionKind: meta?.sessionKind,
        parentSessionId: meta?.parentSessionId,
        btwOrigin: meta?.btwOrigin,
        isTransient: meta?.isTransient,
      });
    });

    await expect(startBtwThread({
      parentSessionId: 'parent-1',
      question: 'Will this send?',
      workspacePath: '/workspace',
    })).rejects.toThrow('backend refused');

    const childSessionId = mockAddExternalSession.mock.calls[0][0];
    const { flowChatManager } = await import('./FlowChatManager');
    expect(flowChatManager.discardLocalSession).toHaveBeenCalledWith(childSessionId);
  });

  it('restores the parent coordinator session before starting a persistent /btw thread', async () => {
    sessions.set('parent-1', {
      ...sessions.get('parent-1'),
      isHistorical: false,
      historyState: 'ready',
      contextRestoreState: 'pending',
    });
    mockAddExternalSession.mockImplementationOnce((sessionId, title, mode, workspacePath, meta) => {
      sessions.set(sessionId, {
        sessionId,
        title,
        mode,
        workspacePath,
        config: {},
        sessionKind: meta?.sessionKind,
        parentSessionId: meta?.parentSessionId,
        btwOrigin: meta?.btwOrigin,
        isTransient: meta?.isTransient,
      });
    });

    await startBtwThread({
      parentSessionId: 'parent-1',
      question: 'Restore the parent first',
      workspacePath: '/workspace',
    });

    expect(mockEnsureBackendSession).toHaveBeenCalledWith('parent-1');
    expect(mockAskStream).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'parent-1',
    }));
  });

  it('uses an explicit model override for /btw sends when provided', async () => {
    sessions.set('btw-child', {
      sessionId: 'btw-child',
      title: 'Side question',
      isTransient: false,
      sessionKind: 'btw',
      config: { modelName: 'parent-multimodal-model' },
      dialogTurns: [],
    });

    await sendMessageToBtwSession({
      parentSessionId: 'parent-1',
      childSessionId: 'btw-child',
      question: 'What is in this image?',
      modelId: 'parent-multimodal-model',
      imagePayload: {
        imageContexts: [
          {
            id: 'img-1',
            image_path: '/tmp/clip.png',
            mime_type: 'image/png',
          },
        ],
        imageDisplayData: [
          {
            id: 'img-1',
            name: 'clip.png',
            imagePath: '/tmp/clip.png',
            mimeType: 'image/png',
          },
        ],
      },
    });

    expect(mockAskStream).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'parent-multimodal-model',
      }),
    );
    expect(mockUpdateSessionModelName).toHaveBeenCalledWith(
      'btw-child',
      'parent-multimodal-model',
    );
  });
});
