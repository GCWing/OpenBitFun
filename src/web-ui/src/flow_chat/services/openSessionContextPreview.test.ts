import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useAgentCanvasStore, switchAgentCanvasScope, forgetAgentCanvasSession } from '@/app/components/panels/content-canvas/stores/canvasStore';
import { flowChatStore } from '../store/FlowChatStore';
import type { Session } from '../types/flow-chat';
import { openSessionContextPreview } from './openSessionContextPreview';

const apiMocks = vi.hoisted(() => ({ getSessionUsageReport: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: apiMocks }));

const params = { sessionId: 'preview-session', reportSessionId: 'preview-session', workspaceId: 'workspace-1', title: 'System prompt.md', category: 'systemPrompt' as const, emptyContent: 'No content in the latest request.' };
const response = () => ({ sessionId: params.sessionId, systemPromptPreview: { content: '# System\n\nExact prompt.\n', cachedAt: 123 } });
const tabs = () => useAgentCanvasStore.getState().primaryGroup.tabs;
const PARENT_SESSION_ID = 'ultimate-parent';
const SWARM_CHILD_ID = 'swarm-worker-child';

/** A reusable swarm child owns the composer while its parent's canvas is live. */
const swarmChildSession = {
  sessionId: SWARM_CHILD_ID, workspaceId: params.workspaceId, sessionKind: 'subagent',
  parentSessionId: PARENT_SESSION_ID, continuationPolicy: 'reusable',
} as unknown as Session;
const swarmChildParams = { ...params, sessionId: SWARM_CHILD_ID, reportSessionId: SWARM_CHILD_ID };

describe('system prompt preview tabs', () => {
  beforeEach(() => {
    activateSurface('local');
    useAgentCanvasStore.getState().closeAllTabs();
    forgetAgentCanvasSession(params.sessionId);
    forgetAgentCanvasSession('another-session');
    forgetAgentCanvasSession(PARENT_SESSION_ID);
    forgetAgentCanvasSession(SWARM_CHILD_ID);
    switchAgentCanvasScope(params.sessionId);
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: params.sessionId }));
    apiMocks.getSessionUsageReport.mockReset().mockResolvedValue(response());
  });

  it('opens a swarm child preview in the parent canvas that presents the child', async () => {
    // The composer can target a reusable subagent child while the parent scene
    // keeps its canvas live; the preview must join that canvas, not a child
    // scope that never becomes live.
    flowChatStore.setState(state => ({ ...state, sessions: new Map([[SWARM_CHILD_ID, swarmChildSession]]) }));
    switchAgentCanvasScope(PARENT_SESSION_ID);
    apiMocks.getSessionUsageReport.mockResolvedValue({ ...response(), sessionId: SWARM_CHILD_ID });

    await expect(openSessionContextPreview(swarmChildParams)).resolves.toBe('opened');
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].content).toMatchObject({
      type: 'markdown-editor', metadata: { sessionId: SWARM_CHILD_ID },
    });
    // The reveal condition keys off the same scope the tab was committed to.
    expect(useAgentCanvasStore.getState().scopeKey).toBe(PARENT_SESSION_ID);
  });

  it('retains a swarm child preview with the child while its parent is not on screen', async () => {
    flowChatStore.setState(state => ({ ...state, sessions: new Map([[SWARM_CHILD_ID, swarmChildSession]]) }));
    switchAgentCanvasScope('another-session');
    apiMocks.getSessionUsageReport.mockResolvedValue({ ...response(), sessionId: SWARM_CHILD_ID });

    await expect(openSessionContextPreview(swarmChildParams)).resolves.toBe('opened');
    // Nothing was revealed on an unrelated canvas; the child keeps its own copy.
    expect(tabs()).toHaveLength(0);
    switchAgentCanvasScope(SWARM_CHILD_ID);
    expect(tabs()).toHaveLength(1);
  });

  it('keeps a swarm child preview in its own canvas when that canvas is live', async () => {
    flowChatStore.setState(state => ({ ...state, sessions: new Map([[SWARM_CHILD_ID, swarmChildSession]]) }));
    switchAgentCanvasScope(SWARM_CHILD_ID);
    apiMocks.getSessionUsageReport.mockResolvedValue({ ...response(), sessionId: SWARM_CHILD_ID });

    await expect(openSessionContextPreview(swarmChildParams)).resolves.toBe('opened');
    expect(tabs()).toHaveLength(1);
    expect(useAgentCanvasStore.getState().scopeKey).toBe(SWARM_CHILD_ID);
  });

  it.each(['local', 'peer-host', 'ssh-workspace'])('opens an immutable Markdown editor from the %s host response', async surface => {
    activateSurface(surface === 'peer-host' ? surface : 'local');
    const workspaceId = surface === 'ssh-workspace' ? 'ssh-workspace-id' : params.workspaceId;
    await expect(openSessionContextPreview({ ...params, workspaceId })).resolves.toBe('opened');
    expect(apiMocks.getSessionUsageReport).toHaveBeenCalledExactlyOnceWith({
      sessionId: params.sessionId, workspaceId, includeHiddenSubagents: false, includeSystemPromptPreview: true, contextPreviewCategory: params.category,
    });
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].content).toMatchObject({
      type: 'markdown-editor', title: params.title,
      data: { initialContent: response().systemPromptPreview.content, readOnly: true, fileName: 'system-prompt.md' },
      metadata: { sessionId: params.sessionId, cachedAt: 123, resourceScope: { workspaceId } },
    });
    expect(tabs()[0].content.data.filePath).toBeUndefined();
    await openSessionContextPreview({ ...params, workspaceId });
    expect(tabs()).toHaveLength(1);
  });

  it('keeps a late preview with its owning session after the user switches chats', async () => {
    let finish: (value: unknown) => void = () => {};
    apiMocks.getSessionUsageReport.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = openSessionContextPreview(params);
    switchAgentCanvasScope('another-session');
    finish(response());
    await expect(pending).resolves.toBe('opened');
    expect(tabs()).toHaveLength(0);
    switchAgentCanvasScope(params.sessionId);
    expect(tabs()).toHaveLength(1);
  });

  it.each(['rules', 'skills', 'mcpTools', 'subagentDefinitions'] as const)(
    'opens %s in its own read-only tab without fetching system prompt content', async category => {
      apiMocks.getSessionUsageReport.mockResolvedValue({ sessionId: params.sessionId,
        contextPreview: { category, content: `# ${category}\n\nRecorded content.`, capturedAt: 456 } });
      await expect(openSessionContextPreview({ ...params, category })).resolves.toBe('opened');
      expect(apiMocks.getSessionUsageReport).toHaveBeenLastCalledWith({
        sessionId: params.sessionId, workspaceId: params.workspaceId, includeHiddenSubagents: false, contextPreviewCategory: category,
      });
      expect(tabs()[0].content.data).toMatchObject({ initialContent: `# ${category}\n\nRecorded content.`, readOnly: true });
      expect(tabs()[0].content.data.filePath).toBeUndefined();
      await openSessionContextPreview({ ...params, category });
      expect(tabs()).toHaveLength(1);
      apiMocks.getSessionUsageReport.mockResolvedValue(response());
      await openSessionContextPreview(params);
      expect(tabs()).toHaveLength(2);
    },
  );

  it('prefers the recorded system category over the legacy cache', async () => {
    apiMocks.getSessionUsageReport.mockResolvedValue({ ...response(),
      contextPreview: { category: params.category, content: '# Request system content', capturedAt: 456 } });
    await openSessionContextPreview(params);
    expect(tabs()[0].content.data.initialContent).toBe('# Request system content');
  });

  it.each(['local', 'peer-host'])('reuses legacy tool preview tabs as structured readers on %s', async surface => {
    activateSurface(surface);
    useAgentCanvasStore.getState().addTab({ type: 'markdown-editor', title: 'Tool definitions.md',
      data: { initialContent: 'old snapshot', readOnly: true },
      metadata: { sessionId: params.sessionId, duplicateCheckKey: `session-context-toolDefinitions-${params.sessionId}` },
    }, 'active');
    const content = '```json\n[{"name":"Read","description":"Read files","parameters":{"type":"object"}}]\n```';
    apiMocks.getSessionUsageReport.mockResolvedValue({ sessionId: params.sessionId,
      contextPreview: { category: 'toolDefinitions', content, capturedAt: 456 } });
    await expect(openSessionContextPreview({ ...params, title: 'Tool definitions', category: 'toolDefinitions' })).resolves.toBe('opened');
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].content).toMatchObject({ type: 'tool-definitions', title: 'Tool definitions', data: { content, readOnly: true } });
    expect(tabs()[0].content.data.filePath).toBeUndefined();
    expect(tabs()[0].content.data.initialContent).toBeUndefined();
  });

  it('distinguishes an empty recorded category from a missing or mismatched preview', async () => {
    apiMocks.getSessionUsageReport.mockResolvedValue({ sessionId: params.sessionId,
      contextPreview: { category: 'rules', content: '', capturedAt: 456 } });
    await expect(openSessionContextPreview({ ...params, category: 'rules' })).resolves.toBe('opened');
    expect(tabs()[0].content.data.initialContent).toBe(params.emptyContent);
    await expect(openSessionContextPreview({ ...params, category: 'skills' })).resolves.toBe('unavailable');
    apiMocks.getSessionUsageReport.mockResolvedValue(response());
    await expect(openSessionContextPreview({ ...params, category: 'skills' })).resolves.toBe('unavailable');
    expect(tabs()).toHaveLength(1);
  });

  it('discards responses from a previous device activation', async () => {
    let finish: (value: unknown) => void = () => {};
    apiMocks.getSessionUsageReport.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = openSessionContextPreview(params);
    activateSurface('peer-host');
    finish(response());
    await expect(pending).resolves.toBe('stale');
    expect(tabs()).toHaveLength(0);
  });

  it.each([undefined, { content: '', cachedAt: 123 }])('does not fabricate content when the host omits a preview: %s', async systemPromptPreview => {
    apiMocks.getSessionUsageReport.mockResolvedValue({ sessionId: params.sessionId, systemPromptPreview });
    await expect(openSessionContextPreview(params)).resolves.toBe('unavailable');
    expect(tabs()).toHaveLength(0);
  });

  it('refuses dispatch projections and mismatched target sessions without querying local content', async () => {
    await expect(openSessionContextPreview({ ...params, reportSessionId: 'target-session' })).resolves.toBe('unavailable');
    flowChatStore.setState(state => ({ ...state, sessions: new Map([[params.sessionId, {
      sessionId: params.sessionId, config: { dispatchJobId: 'job-1' },
    } as Session]]) }));
    await expect(openSessionContextPreview(params)).resolves.toBe('unavailable');
    expect(apiMocks.getSessionUsageReport).not.toHaveBeenCalled();
  });

  it('treats a peer host without the usage report as unavailable rather than a failure', async () => {
    apiMocks.getSessionUsageReport.mockRejectedValue(new Error(
      "command 'get_session_usage_report' is not supported on CLI peer host: the CLI peer host has no handler for this command",
    ));
    await expect(openSessionContextPreview(params)).resolves.toBe('unavailable');
    expect(tabs()).toHaveLength(0);
  });

  it('propagates host errors without creating an empty editor', async () => {
    apiMocks.getSessionUsageReport.mockRejectedValue(new Error('Host offline'));
    await expect(openSessionContextPreview(params)).rejects.toThrow('Host offline');
    expect(tabs()).toHaveLength(0);
  });
});
