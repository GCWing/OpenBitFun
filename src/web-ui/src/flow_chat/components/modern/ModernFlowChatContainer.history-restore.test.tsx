// @vitest-environment jsdom
import React, { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionHistoryPresentation } from '../../types/flow-chat';
import type { VirtualMessageList } from './VirtualMessageList';
import type { FlowChatTurnRail } from './FlowChatTurnRail';

const fixture = vi.hoisted(() => ({
  session: null as Session | null,
  listProps: null as ComponentProps<typeof VirtualMessageList> | null,
  viewportSettled: true,
  cached: null as SessionHistoryPresentation | null,
  restore: vi.fn(),
  restoreTail: vi.fn(),
  loadTurnWindow: vi.fn(),
  present: null as ((sessionId: string, presentation: SessionHistoryPresentation) => void) | null,
}));
vi.mock('../../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ activeSessionId: fixture.session?.sessionId, sessions: new Map(fixture.session ? [[fixture.session.sessionId, fixture.session]] : []) }),
  retainSessionHistory: () => () => {},
  subscribeSelector: () => () => {},
  getSessionHistoryViewState: () => undefined,
  reactivateSessionHistoryWindow: () => fixture.cached,
  restoreSessionHistoryWindow: (...args: unknown[]) => fixture.restore(...args),
  restoreSessionTailPresentation: (...args: unknown[]) => fixture.restoreTail(...args),
  hasPendingSessionHistoryCompletion: () => false,
  hasDeferredSessionHistoryProjection: () => false,
  releaseSessionHistoryCompletionAfterInitialPaint: () => false,
  extendSessionHistoryWindow: () => null,
  loadSessionTurnWindow: (...args: unknown[]) => fixture.loadTurnWindow(...args),
  activateSessionHistoryWindow: () => fixture.cached,
} }));
vi.mock('../../store/modernFlowChatStore', async importOriginal => {
  const original = await importOriginal<typeof import('../../store/modernFlowChatStore')>();
  const projectSession = original.createSessionVirtualItemProjector();
  return { ...original,
    useActiveSession: () => fixture.session,
    useVirtualItems: () => projectSession(fixture.session!),
    useVisibleTurnInfo: () => null,
  };
});
vi.mock('./VirtualMessageList', () => ({ VirtualMessageList: React.forwardRef((props: ComponentProps<typeof VirtualMessageList>, ref) => {
  fixture.listProps = props;
  React.useImperativeHandle(ref, () => ({
    scrollToTurnEnd: () => true,
    captureViewportSnapshot: () => null,
    clearSearchMatch: () => {},
    prepareTurnNavigation: () => 'pending',
  }));
  return <div className="virtual-message-list" data-open-viewport-settled={String(fixture.viewportSettled)}>
    {props.items.map((item, index) => <span key={index} data-turn-id={item.turnId}>{item.turnId}</span>)}
  </div>;
}) }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ FlowChatManager: {} }));
vi.mock('./FlowChatHeader', () => ({ FlowChatHeader: ({ visible }: { visible: boolean }) => visible ? <header data-testid="history-header" /> : null }));
vi.mock('./FlowChatTurnRail', () => ({ FlowChatTurnRail: ({ turns, onNavigate }: ComponentProps<typeof FlowChatTurnRail>) => (
  <nav data-testid="turn-rail">{turns.map(turn => (
    <button key={turn.itemKey} data-rail-ordinal={turn.ordinal} onClick={() => onNavigate(turn)}>{turn.turnIndex}</button>
  ))}</nav>
) }));
vi.mock('../background-command/BackgroundCommandInputDialog', () => ({ BackgroundCommandInputDialog: () => null }));
vi.mock('../WelcomePanel', () => ({ WelcomePanel: () => <div data-testid="empty-session" /> }));
vi.mock('./HistorySessionPlaceholder', () => ({ HistorySessionPlaceholder: ({ onRetry }: { onRetry: () => void }) => <button onClick={onRetry}>Retry history</button> }));
vi.mock('./useFlowChatSync', () => ({ useFlowChatSync: () => {} }));
vi.mock('./useFlowChatNavigation', () => ({ useFlowChatNavigation: () => {} }));
vi.mock('./useFlowChatCopyDialog', () => ({ useFlowChatCopyDialog: () => {} }));
vi.mock('./useFlowChatToolActions', () => ({ useFlowChatToolActions: () => ({}) }));
vi.mock('./useFlowChatFileActions', () => ({ useFlowChatFileActions: () => ({}) }));
vi.mock('./useFlowChatHttpLinkClick', () => ({ useFlowChatHttpLinkClick: () => undefined }));
vi.mock('./usePermissionRequests', () => ({ usePermissionRequests: () => ({ requests: [] }) }));
vi.mock('../../trajectory/TrajectoryExplorer', () => ({ TrajectoryExplorer: () => null }));
vi.mock('../../trajectory/trajectoryPanel', () => ({ TRAJECTORY_NAVIGATE_EVENT: 'test:trajectory', showTrajectoryRange: () => {} }));
vi.mock('../../trajectory/useTrajectoryNavigation', () => ({ useTrajectoryNavigation: ({ present }: { present: typeof fixture.present }) => {
  fixture.present = present;
  return () => false;
} }));
vi.mock('../../selection/FlowChatSelectionBar', () => ({ FlowChatSelectionBar: () => null }));
vi.mock('../../selection/ConversationExcerptSources', () => ({ ConversationExcerptSourceProvider: ({ children }: React.PropsWithChildren) => children }));
vi.mock('../../services/btwSessionPane', () => ({ openBtwSessionInAuxPane: () => {} }));
vi.mock('../../services/deleteSessionTreeBranch', () => ({ deleteSessionTreeBranch: () => {} }));
vi.mock('@/infrastructure/hooks/useShortcut', () => ({ useShortcut: () => {} }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useWorkspaceContext: () => ({}) }));
vi.mock('@/app/utils/projectSessionWorkspace', () => ({ flowChatSessionConfigForCurrentWorkspace: () => ({}) }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: {
  listBackgroundCommandActivities: async () => ({ activities: [] }),
} }));

import { ModernFlowChatContainer } from './ModernFlowChatContainer';
import { registerConversationReader, stageConversationViewTransfer } from './flowChatViewHandoff';
import { activateSurface, getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function session(totalTurnCount = 8, historyState: Session['historyState'] = 'ready'): Session {
  return {
    sessionId: 'session-a', title: 'Conversation', mode: 'Standard', config: {},
    historyState, contextRestoreState: 'ready', totalTurnCount, isPartial: true,
    dialogTurns: totalTurnCount === 0 ? [] : [{
      id: `turn-${totalTurnCount - 1}`, status: 'completed', modelRounds: [],
      userMessage: { id: `user-${totalTurnCount - 1}`, content: 'Question', timestamp: 1 },
    }],
  } as Session;
}
function presentation(startOrdinal = 4, endOrdinalExclusive = 8): SessionHistoryPresentation {
  return {
    range: { startOrdinal, endOrdinalExclusive, targetTurnId: `turn-${startOrdinal}`, mode: 'history-window' },
    turns: Array.from({ length: endOrdinalExclusive - startOrdinal }, (_, i) => ({
      id: `turn-${startOrdinal + i}`, status: 'completed', modelRounds: [],
      userMessage: { id: `user-${startOrdinal + i}`, content: 'Question', timestamp: 1 },
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('FlowChat reader restoration across history rewrites', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => root.render(<ModernFlowChatContainer />)); };
  const messages = () => host.querySelector<HTMLElement>('[data-testid="flowchat-messages"]')!;
  const expectPresented = () => {
    expect(messages().dataset.showHistoryLoadingLayer).toBe('false');
    expect(messages().dataset.historyInitialContentReady).toBe('true');
    expect(host.querySelector('.history-session-loading__overlay')).toBeNull();
  };
  function stageBookmark(window = presentation(), withSnapshot = false) {
    const ref = { surfaceId: getActiveSurfaceScope().surfaceId, sessionId: 'session-a' };
    const unregister = registerConversationReader(ref, 'dock', () => ({
      // Also exercise the legacy snapshot shape without an exact item key.
      snapshot: withSnapshot ? {
        sessionId: ref.sessionId, presentationMode: 'history-window', viewportMode: 'history-reading',
        historyWindow: window.range, anchorTurnId: window.range.targetTurnId,
        anchorOffsetPx: 24, scrollTopPx: 400, isAtTail: false, capturedAtMs: 1,
      } : null,
      historyPresentation: { sessionId: ref.sessionId, range: window.range, revision: 1 },
      viewportIntent: { kind: 'turn', sessionId: ref.sessionId, ordinal: window.range.startOrdinal,
        turnId: window.range.targetTurnId, source: 'history-range' },
    }));
    stageConversationViewTransfer(ref, 'dock');
    unregister();
  }
  beforeEach(() => {
    vi.clearAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
    fixture.session = session();
    fixture.cached = presentation();
    fixture.restore.mockResolvedValue(null);
    fixture.listProps = null;
    fixture.viewportSettled = true;
    fixture.present = null;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    activateSurface(LOCAL_SURFACE_ID);
  });

  it.each([
    ['local', true, 7], ['local', false, 7], ['local', true, 0], ['local', false, 0],
    ['peer-device', false, 7], ['peer-device', false, 0],
  ] as const)('presents rollback on %s (hydrating commit: %s, surviving Turns: %d)', async (surface, hydrating, remaining) => {
    activateSurface(surface);
    stageBookmark(presentation(), true);
    await render();
    expectPresented();
    if (hydrating) {
      fixture.session = session(8, 'hydrating');
      await render();
    }
    fixture.cached = null;
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    fixture.session = session(remaining);
    await render();
    await act(async () => read.resolve(null));
    expectPresented();
    expect(messages().dataset.presentationMode).toBe('tail');
    if (remaining) expect(fixture.listProps?.initialViewportSnapshot).toBeNull();
    expect(host.querySelector(remaining ? '[data-turn-id="turn-6"]' : '[data-testid="empty-session"]')).not.toBeNull();
    expect(fixture.restore).not.toHaveBeenCalled();

    // A second refresh must not revive the retired bookmark or reading anchor.
    fixture.session = session(remaining, 'hydrating');
    await render();
    fixture.session = session(remaining);
    await render();
    expectPresented();
    expect(fixture.restore).not.toHaveBeenCalled();
  });

  it('drops an invalid bookmark before a cold host transfer tries to restore it', async () => {
    fixture.session = session(3);
    fixture.cached = null;
    stageBookmark();
    await render();
    expectPresented();
    expect(fixture.restore).not.toHaveBeenCalled();
    expect(messages().dataset.presentationMode).toBe('tail');
  });

  it('restores a still-valid reader range instead of discarding it on every refresh', async () => {
    const window = presentation(2, 4);
    fixture.cached = null;
    stageBookmark(window);
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    await render();
    expect(messages().dataset.showHistoryLoadingLayer).toBe('true');
    await act(async () => read.resolve(window));
    expectPresented();
    expect(messages().dataset.presentationMode).toBe('history-window');
    expect(host.querySelector('[data-turn-id="turn-2"]')).not.toBeNull();
  });

  it('cancels a pending cold range when a ready history rewrite removes it', async () => {
    fixture.cached = null;
    stageBookmark();
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    await render();
    expect(messages().dataset.showHistoryLoadingLayer).toBe('true');
    fixture.session = session(4);
    await render();
    expectPresented();
    await act(async () => read.resolve(presentation()));
    expectPresented();
    expect(messages().dataset.presentationMode).toBe('tail');
    expect(host.querySelector('[data-turn-id="turn-7"]')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ends a superseded restore immediately and ignores its late %s', async outcome => {
    fixture.cached = null;
    stageBookmark();
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    await render();
    expect(messages().dataset.showHistoryLoadingLayer).toBe('true');
    await act(async () => fixture.present!('session-a', presentation(1, 3)));
    expectPresented();
    await act(async () => {
      if (outcome === 'resolve') read.resolve(presentation());
      else read.reject(new Error('Old reader failed'));
    });
    expectPresented();
    expect(host.querySelector('[data-turn-id="turn-1"]')).not.toBeNull();
    expect(host.querySelector('[data-turn-id="turn-7"]')).toBeNull();
  });

  it('still waits for the surviving viewport to settle after retiring the cold restore', async () => {
    fixture.cached = null;
    stageBookmark();
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    await render();
    fixture.viewportSettled = false;
    fixture.session = session(7);
    await render();
    expect(messages().dataset.showHistoryLoadingLayer).toBe('false');
    expect(messages().dataset.historyInitialContentReady).toBe('false');
    expect(host.querySelector('.history-session-loading__overlay')).not.toBeNull();
    fixture.viewportSettled = true;
    await render();
    expectPresented();
    await act(async () => read.resolve(null));
    expectPresented();
  });

  it('exposes a current restore failure and retries the retained bookmark', async () => {
    const window = presentation(2, 4);
    fixture.cached = null;
    stageBookmark(window);
    fixture.restore.mockRejectedValueOnce(new Error('History transport failed'));
    await render();
    expectPresented();
    const retry = host.querySelector<HTMLButtonElement>('button')!;
    expect(retry.textContent).toBe('Retry history');
    fixture.restore.mockResolvedValueOnce(window);
    await act(async () => retry.click());
    expectPresented();
    expect(fixture.restore).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-turn-id="turn-2"]')).not.toBeNull();
  });

  it('does not let a late restore hide another selected Session', async () => {
    fixture.cached = null;
    stageBookmark();
    const read = deferred<SessionHistoryPresentation | null>();
    fixture.restore.mockReturnValue(read.promise);
    await render();
    fixture.session = { ...session(2), sessionId: 'session-b' };
    await render();
    expectPresented();
    await act(async () => read.reject(new Error('Old session disconnected')));
    expectPresented();
    expect(messages().dataset.activeSessionId).toBe('session-b');
  });

  it('keeps a plain tail readable across overlapping reload notifications', async () => {
    await render();
    fixture.session = session(8, 'hydrating');
    await render();
    fixture.session = session(7);
    await render();
    fixture.session = session(7, 'hydrating');
    await render();
    fixture.session = session(7);
    await render();
    expectPresented();
    expect(fixture.restore).not.toHaveBeenCalled();
  });

  it('keeps earlier history reachable when a ready internal tail deliberately projects no rows', async () => {
    fixture.session = session(8);
    const turn = fixture.session.dialogTurns[0];
    turn.userMessage = { ...turn.userMessage, metadata: { genUIHostRepair: true } };
    await render();
    expect(messages().dataset.virtualItemCount).toBe('0');
    expectPresented();
    expect(host.querySelector('[data-testid="empty-session"]')).toBeNull();
    expect(host.querySelector('[data-testid="history-header"]')).not.toBeNull();
    expect(host.querySelector('.virtual-message-list')).not.toBeNull();
    fixture.cached = presentation(0, 2);
    fixture.loadTurnWindow.mockResolvedValueOnce({
      status: 'ready', isCurrent: true, targetOrdinal: 0, targetTurnId: 'turn-0', navigationGeneration: 1,
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-rail-ordinal="0"]')!.click());
    expectPresented();
    expect(fixture.loadTurnWindow).toHaveBeenCalledWith('session-a', 0, { source: 'target' });
    expect(host.querySelector('[data-turn-id="turn-0"]')).not.toBeNull();
  });
});
