// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationExcerptContext } from '@/shared/types/context';

/*
 * The two properties this file exists for, both measured from a usage-report
 * click before they held:
 *
 * - the aim goes through the register, not `element.scrollIntoView`;
 * - it is attempted in the same task as the Turn navigation, so the reader is
 *   not shown the Turn placement and then moved off it. Measured: the Turn
 *   navigation settled 178px and 334.7px from where it put itself, because
 *   this aim arrived three frames later and the intermediate frame was painted.
 */

const mocks = vi.hoisted(() => ({
  resolveFlowChatFocusTarget: vi.fn(),
  switchChatSession: vi.fn(),
  navigateToFocusTurn: vi.fn(),
  activeSessionId: 'session-1' as string | undefined,
}));

vi.mock('../../services/FlowChatManager', () => ({
  flowChatManager: { switchChatSession: mocks.switchChatSession },
}));
vi.mock('../../store/FlowChatStore', () => ({
  flowChatStore: { getState: () => ({ sessions: new Map(), activeSessionId: mocks.activeSessionId }) },
}));
vi.mock('../../store/modernFlowChatStore', () => ({
  useModernFlowChatStoreApi: () => ({
    getState: () => ({ activeSession: { sessionId: mocks.activeSessionId } }),
  }),
}));
vi.mock('./flowChatFocusTarget', () => ({
  resolveFlowChatFocusTarget: mocks.resolveFlowChatFocusTarget,
}));

const { globalEventBus } = await import('@/infrastructure/event-bus');
const { FLOWCHAT_FOCUS_ITEM_EVENT } = await import('../../events/flowchatNavigation');
const { useFlowChatNavigation } = await import('./useFlowChatNavigation');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no CSS.escape. The ids here need no escaping; this only has to
// exist so the selector can be built.
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as { CSS?: unknown }).CSS = {};
}
if (typeof CSS.escape !== 'function') {
  CSS.escape = (value: string) => value.replace(/["\\]/g, '\\$&');
}

const FOCUS_ITEM_ID = 'call_00_zknuBLUKP7Y6JTioDI5Z8386';
const excerpt: ConversationExcerptContext = {
  id: 'excerpt-1', timestamp: 1, type: 'conversation-excerpt',
  source: { surfaceId: 'local', sessionId: 'session-1', sessionName: 'Session' },
  fragments: [{ turnId: 'turn-1', flowItemId: FOCUS_ITEM_ID, text: 'quote', start: 7, end: 12,
    prefix: 'source ', suffix: '' }],
};

function Harness({ listRef, containerRef }: { listRef: React.RefObject<any>; containerRef: React.RefObject<HTMLElement> }) {
  useFlowChatNavigation({
    containerRef,
    activeSessionId: 'session-1',
    virtualItems: [],
    virtualListRef: listRef,
    onNavigateToFocusTurn: mocks.navigateToFocusTurn,
  });
  return null;
}

describe('useFlowChatNavigation focus placement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let listRef: React.RefObject<any>;
  let focusFlowItem: ReturnType<typeof vi.fn>;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  function renderItem() {
    const element = document.createElement('div');
    element.dataset.flowItemId = FOCUS_ITEM_ID;
    element.scrollIntoView = scrollIntoView as unknown as HTMLElement['scrollIntoView'];
    container.append(element);
    return element;
  }

  async function dispatchFocusRequest(extra: Record<string, unknown> = {}) {
    await act(async () => {
      globalEventBus.emit(FLOWCHAT_FOCUS_ITEM_EVENT, {
        sessionId: 'session-1',
        itemId: FOCUS_ITEM_ID,
        ...extra,
      });
      // Let the handler's own awaits resolve, without granting it a frame.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    mocks.activeSessionId = 'session-1';
    mocks.navigateToFocusTurn.mockResolvedValue(false);
    mocks.resolveFlowChatFocusTarget.mockReturnValue({ preferTurnNavigation: false });
    scrollIntoView = vi.fn();
    focusFlowItem = vi.fn(() => true);
    listRef = { current: { focusFlowItem, navigateToTurn: vi.fn(), scrollToIndex: vi.fn(), scrollToTurn: vi.fn(), scrollToSearchMatch: vi.fn() } };
    frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Harness listRef={listRef} containerRef={{ current: container }} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('aims through the register rather than the element', async () => {
    renderItem();
    await dispatchFocusRequest();

    expect(focusFlowItem).toHaveBeenCalledWith(FOCUS_ITEM_ID);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('aims without first yielding a frame to the Turn placement', async () => {
    renderItem();
    await dispatchFocusRequest();

    // Nothing has been given a frame yet: every queued callback is still queued.
    expect(frames).toHaveLength(0);
    expect(focusFlowItem).toHaveBeenCalledTimes(1);
  });

  it('highlights only the requesting host when another retained view has the same item', async () => {
    const other = document.createElement('div');
    other.dataset.flowItemId = FOCUS_ITEM_ID;
    document.body.prepend(other);
    const owned = renderItem();
    await dispatchFocusRequest();
    expect(owned.classList.contains('flowchat-flow-item--focused')).toBe(true);
    expect(other.classList.contains('flowchat-flow-item--focused')).toBe(false);
  });

  it('asks again on the next frame while the item is still unrendered', async () => {
    await dispatchFocusRequest();
    expect(focusFlowItem).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    renderItem();
    await act(async () => { frames.shift()?.(16); });

    expect(focusFlowItem).toHaveBeenCalledWith(FOCUS_ITEM_ID);
  });

  it('delegates exact excerpts to the text navigator and cancels on reader intent', async () => {
    mocks.resolveFlowChatFocusTarget.mockReturnValue({ resolvedVirtualIndex: 0 });
    await dispatchFocusRequest({ excerpt });
    const target = listRef.current.scrollToSearchMatch.mock.calls[0][0];
    expect(target).toMatchObject({ virtualItemIndex: 0, excerpt });
    expect(listRef.current.scrollToIndex).not.toHaveBeenCalled();
    expect(focusFlowItem).not.toHaveBeenCalled();
    expect(target.isCurrent()).toBe(true);
    window.dispatchEvent(new Event('wheel'));
    expect(target.isCurrent()).toBe(false);
  });

  it('reports a source history failure without leaving an unhandled request', async () => {
    mocks.navigateToFocusTurn.mockRejectedValueOnce(new Error('source unavailable'));
    const onUnavailable = vi.fn();
    await dispatchFocusRequest({ excerpt, onUnavailable });
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(listRef.current.scrollToSearchMatch).not.toHaveBeenCalled();
  });
});
