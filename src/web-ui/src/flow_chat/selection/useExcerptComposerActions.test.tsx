// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationExcerptContext } from '@/shared/types/context';
import type { QueuedMessage } from '../types/flow-chat';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { sessionComposerStore } from '../store/sessionComposerStore';
import { useContextStore } from '@/shared/stores/contextStore';
import { requestExcerptAction, FLOWCHAT_EXCERPT_ACTION } from './excerptActions';
import { useExcerptComposerActions } from './useExcerptComposerActions';
import { withConversationExcerpts } from '../utils/composerPresentation';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  setTarget: vi.fn(), focus: vi.fn(), openPane: vi.fn(), expand: vi.fn(), create: vi.fn(),
  queue: vi.fn<() => QueuedMessage[]>(() => []),
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: mocks.sessions, activeSessionId: 'main' }),
} }));
vi.mock('../services/BtwThreadService', () => ({ createBtwSessionPlaceholder: mocks.create }));
vi.mock('../services/flow-chat-manager/PendingQueueModule', () => ({ pendingQueueManager: { listForSurface: mocks.queue } }));
vi.mock('../services/btwSessionPane', () => ({ openBtwSessionInAuxPane: mocks.openPane }));
vi.mock('../services/sessionActivation', () => ({ openMainSession: vi.fn() }));
vi.mock('@/app/scenes/session/sessionPanelLayout', () => ({ expandSessionAuxPane: mocks.expand }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../session-drivers/resolve', () => ({ resolveSessionDriverId: () => 'local' }));

const excerpt: ConversationExcerptContext = {
  id: 'excerpt-1', timestamp: 1, type: 'conversation-excerpt',
  source: { surfaceId: 'local', sessionId: 'main', sessionName: 'Main' },
  fragments: [{ turnId: 'turn-2', text: 'text', start: 0, end: 4, prefix: '', suffix: '' }],
};
function Probe({ target = 'main', active = true }: { target?: string; active?: boolean }) {
  useExcerptComposerActions({ mainSessionId: 'main', targetSessionId: target, active,
    setInputTarget: mocks.setTarget, focus: mocks.focus });
  return null;
}
describe('scoped excerpt composer routing', () => {
  let root: Root;
  let container: HTMLDivElement;
  const frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.queue.mockReset();
    mocks.queue.mockReturnValue([]);
    activateSurface('local');
    sessionComposerStore.setState({ drafts: {} });
    useContextStore.getState().clearContexts();
    mocks.sessions.clear();
    mocks.sessions.set('main', { sessionId: 'main', workspacePath: '/workspace', dialogTurns: [], config: {} });
    mocks.sessions.set('draft', { sessionId: 'draft', parentSessionId: 'main', sessionKind: 'btw', dialogTurns: [] });
    frames.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => undefined; });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('adds to the main draft without replacing text or attachments in either target', () => {
    const sideQuote = { ...excerpt, id: 'side-quote', source: { ...excerpt.source, sessionId: 'draft' } };
    sessionComposerStore.getState().setValue('main', 'Unsent main question');
    sessionComposerStore.getState().setValue('draft', 'Unsent side question');
    useContextStore.getState().replaceContexts([sideQuote]);
    act(() => root.render(<Probe target="draft" />));
    act(() => expect(requestExcerptAction({ ...sideQuote, comment: 'My note' }, 'main', 'annotate')).toBe(true));
    expect(sessionComposerStore.getState().getDraft('main')).toMatchObject({
      value: 'Unsent main question', contexts: [{ ...sideQuote, annotationNumber: 1, comment: 'My note' }],
    });
    expect(sessionComposerStore.getState().getDraft('draft')).toMatchObject({
      value: 'Unsent side question', contexts: [sideQuote],
    });
    expect(mocks.setTarget).toHaveBeenCalledWith('main');
    expect(mocks.openPane).not.toHaveBeenCalled();
  });

  it('reuses an ordinary unsent side draft and focuses after target activation', () => {
    sessionComposerStore.getState().setValue('draft', 'Keep this question');
    act(() => root.render(<Probe />));
    act(() => requestExcerptAction(excerpt, 'main', 'ask'));
    act(() => root.render(<Probe target="draft" />));
    act(() => frames.forEach(frame => frame(0)));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.openPane).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'draft', expand: false }));
    expect(mocks.expand).toHaveBeenCalledOnce();
    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(sessionComposerStore.getState().getDraft('draft')).toMatchObject({ value: 'Keep this question', contexts: [{ ...excerpt, annotationNumber: 1 }] });
  });

  it('continues numbering while earlier annotations wait in the send queue', () => {
    mocks.queue.mockReturnValue([{ id: 'queued', sessionId: 'main', content: 'Question', timestamp: 1, status: 'queued', retryCount: 0, userMessageMetadata: {
      composerPresentation: withConversationExcerpts(null, [{ ...excerpt, id: 'queued', annotationNumber: 3 }]),
    } }]);
    act(() => root.render(<Probe />));
    act(() => requestExcerptAction(excerpt, 'main', 'annotate'));
    expect(sessionComposerStore.getState().getDraft('main').contexts).toEqual([{ ...excerpt, annotationNumber: 4 }]);
  });

  it('creates a new ordinary side draft instead of using review or already submitted sessions', () => {
    mocks.sessions.set('draft', { sessionId: 'draft', parentSessionId: 'main', sessionKind: 'review', dialogTurns: [] });
    mocks.sessions.set('sent', { sessionId: 'sent', parentSessionId: 'main', sessionKind: 'btw', btwOrigin: { requestId: 'sent-1' }, dialogTurns: [] });
    mocks.create.mockReturnValueOnce({ childSessionId: 'new-side' });
    act(() => root.render(<Probe />));
    act(() => requestExcerptAction(excerpt, 'main', 'ask'));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'main', parentDialogTurnId: 'turn-2' }));
    expect(sessionComposerStore.getState().getDraft('new-side').contexts).toEqual([{ ...excerpt, annotationNumber: 1 }]);
  });

  it('ignores inactive composers and events from another session or an earlier surface activation', () => {
    act(() => root.render(<Probe active={false} />));
    act(() => expect(requestExcerptAction(excerpt, 'main', 'annotate')).toBe(false));
    act(() => root.render(<Probe />));
    act(() => expect(requestExcerptAction(excerpt, 'unrelated', 'annotate')).toBe(false));
    const previous = getActiveSurfaceScope();
    activateSurface('local');
    act(() => window.dispatchEvent(new CustomEvent(FLOWCHAT_EXCERPT_ACTION, { detail: {
      excerpt, parentSessionId: 'main', action: 'annotate', surfaceEpoch: previous.epoch,
    } })));
    expect(mocks.setTarget).not.toHaveBeenCalled();
    expect(sessionComposerStore.getState().getDraft('main').contexts).toEqual([]);
  });
});
