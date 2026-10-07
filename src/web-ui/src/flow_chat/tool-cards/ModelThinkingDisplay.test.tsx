// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@openbitfun/ui';
import { FileOperationToolCard } from '@openbitfun/ui/flow-chat';
import type { FlowThinkingItem } from '../types/flow-chat';
import { ModelThinkingDisplay } from './ModelThinkingDisplay';
import { latestReasoningSummaryPreview } from '../utils/reasoningSummaryPresentation';
import { openThinkingPanel } from '../services/openThinkingPanel';
import { FlowChatContext } from '../components/modern/FlowChatContext';
import { FlowChatReaderProvider, FlowChatReaderState } from '../timeline/readerState';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

vi.mock('../utils/reasoningSummaryPresentation', { spy: true });
vi.mock('../services/openThinkingPanel', () => ({ openThinkingPanel: vi.fn() }));
beforeEach(() => vi.mocked(openThinkingPanel).mockClear());

const markdownRender = vi.hoisted(() => vi.fn());

const revealState = vi.hoisted(() => ({ isRevealing: false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) => ({
      'toolCards.think.thinking': 'Thinking...',
      'toolCards.think.thinkingProcess': 'Thinking Process',
      'toolCards.think.thinkingSummary': 'Thinking Summary',
      'toolCards.think.thinkingComplete': 'Thinking complete',
      'toolCards.think.thinkingCharacters': `Thought ${values?.count ?? 0} characters`,
    })[key] ?? key,
  }),
}));

vi.mock('../hooks/useTypewriter', () => ({
  useTypewriter: (content: string) => ({ displayText: content, isRevealing: revealState.isRevealing }),
}));

vi.mock('../hooks/typewriterRevealGateContext', () => ({
  useReportTypewriterReveal: () => {},
}));

vi.mock('./useToolCardHeightContract', () => ({
  useToolCardHeightContract: () => ({
    cardRootRef: { current: null },
    dispatchToolCardToggle: vi.fn(),
    applyExpandedState: (
      current: boolean,
      next: boolean,
      setExpanded: (value: boolean) => void,
    ) => {
      if (current !== next) setExpanded(next);
    },
  }),
}));

vi.mock('@/infrastructure/markdown', () => ({
  ThinkingMarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
    markdownRender(content);
    return <div data-testid="thinking-markdown" data-markdown-streaming={isStreaming}>{content}</div>;
  },
}));

function summaryItem(content: string): FlowThinkingItem {
  return {
    id: 'summary-1',
    type: 'thinking',
    reasoningKind: 'summary',
    content,
    isStreaming: true,
    isCollapsed: false,
    timestamp: 1,
    status: 'streaming',
  };
}

describe('ModelThinkingDisplay reasoning summary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    markdownRender.mockClear();
    revealState.isRevealing = false;
    vi.mocked(latestReasoningSummaryPreview).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('temporarily reveals a completed search source without opening the details panel', async () => {
    const reader = new FlowChatReaderState();
    const item = { ...summaryItem('Find this recorded thought'), isStreaming: false, status: 'completed' as const };
    await act(async () => root.render(<FlowChatReaderProvider store={reader}>
      <ModelThinkingDisplay thinkingItem={item} />
    </FlowChatReaderProvider>));
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')?.getAttribute('data-expanded')).toBe('false');
    act(() => reader.set('navigation:thinking', item.id));
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent).toBe(item.content);
    expect(openThinkingPanel).not.toHaveBeenCalled();
    act(() => reader.set('navigation:thinking', ''));
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')?.getAttribute('data-expanded')).toBe('false');
  });

  it.each(['reasoning', undefined] as const)(
    'skips summary processing for streaming reasoning (kind=%s)', async reasoningKind => {
      const item = { ...summaryItem('**Reasoning**\n\n'.repeat(7000)), reasoningKind };
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
      const content = `${item.content}More`;
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={{ ...item, content }} />));
      expect(latestReasoningSummaryPreview).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent).toBe(content);
    },
  );

  it('computes the preview when the kind changes to summary with unchanged content', async () => {
    const item = summaryItem('**Latest summary**');
    await act(async () => root.render(<ModelThinkingDisplay
      thinkingItem={{ ...item, reasoningKind: 'reasoning' }} isLastItem={false} />));
    expect(latestReasoningSummaryPreview).not.toHaveBeenCalled();
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} isLastItem={false} />));
    expect(latestReasoningSummaryPreview).toHaveBeenCalledWith(item.content);
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('Latest summary');
  });

  it('defaults to a collapsed single-line preview of the latest summary part', async () => {
    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem(
        '**Inspecting the stream**\n\n**Preparing the repair**',
      )} />);
    });

    const panel = container.querySelector('[data-testid="chat-thinking-panel"]');
    const label = container.querySelector('[data-openbitfun-part="label"]');
    expect(panel?.getAttribute('data-expanded')).toBe('false');
    expect(label?.textContent).toBe('Preparing the repair');
    expect(label?.textContent).not.toContain('characters');
    expect(markdownRender).not.toHaveBeenCalled();
  });

  it('does not render a large collapsed reasoning body, including content updates', async () => {
    const item = { ...summaryItem('**Reasoning**\n\n'.repeat(6000)),
      reasoningKind: 'reasoning' as const, isStreaming: false, status: 'completed' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} isLastItem={false} />));
    await act(async () => root.render(<ModelThinkingDisplay
      thinkingItem={{ ...item, content: `${item.content}More` }} isLastItem={false} />));
    expect(markdownRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat-thinking-content"]')).toBeNull();
  });

  it('mounts and releases content when forced expansion changes without an animation', async () => {
    const item = summaryItem('**Full summary**');
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent).toBe(item.content);
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
  });

  it.each(['finish', 'cancel', 'reopen'] as const)(
    'retains closing content until the actual transition settles: %s', async outcome => {
      const item = summaryItem('**Body**');
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded />));
      const body = container.querySelector('[data-testid="thinking-markdown"]');
      let finish!: () => void;
      let cancel!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        cancel = () => reject(new Error('Transition cancelled'));
      });
      const expandContainer = container.querySelector('[data-openbitfun-part="expandContainer"]') as HTMLElement;
      Object.defineProperty(expandContainer, 'getAnimations', {
        value: () => [{ transitionProperty: 'grid-template-rows', finished }],
      });
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
      expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(body);
      if (outcome === 'reopen') await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded />));
      await act(async () => { if (outcome === 'finish') finish(); else cancel(); });
      expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(outcome === 'reopen' ? body : null);
    },
  );

  it('keeps the thinking indicator mounted and stops motion when streaming completes', async () => {
    const item = summaryItem('**Inspecting**');
    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={item} />);
    });

    const leadingIcon = container.querySelector('[data-openbitfun-part="leadingIcon"]');
    const indicator = leadingIcon?.querySelector('[data-openbitfun-component="thinking-indicator"]');
    expect(indicator?.getAttribute('data-active')).toBe('true');
    expect(leadingIcon?.querySelector('[data-openbitfun-name="chevron-right"]')).toBeNull();
    expect(leadingIcon?.querySelector('[data-openbitfun-name="chevron-down"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-thinking-toggle"]')?.hasAttribute('aria-haspopup')).toBe(false);
    expect(container.querySelector('[data-testid="chat-thinking-toggle"]')?.getAttribute('aria-expanded')).toBe('false');

    // Finishing the visual text reveal must not keep reporting active thinking.
    revealState.isRevealing = true;
    await act(async () => root.render(<ModelThinkingDisplay
      thinkingItem={{ ...item, isStreaming: false, status: 'completed' }} />));
    expect(container.querySelector('[data-openbitfun-component="thinking-indicator"]')).toBe(indicator);
    expect(indicator?.getAttribute('data-active')).toBe('false');
  });

  it.each([false, true])('retains the outgoing line limit throughout completion (seven lines: %s)', async expanded => {
    const item = { ...summaryItem('A long reasoning paragraph. '.repeat(200)), reasoningKind: 'reasoning' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    if (expanded) await act(async () => toggle.click());
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    const body = container.querySelector('[data-testid="thinking-markdown"]');
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    Object.defineProperty(container.querySelector('.thinking-expand-container'), 'getAnimations', {
      value: () => [{ transitionProperty: 'grid-template-rows', finished }],
    });
    const completed = { ...item, isStreaming: false, status: 'completed' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} />));
    expect(panel.dataset.expanded).toBe('false');
    expect(panel.dataset.streamingExpanded).toBeUndefined();
    expect(panel.dataset.thinkingViewport).toBe(expanded ? 'expanded' : 'compact');
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(body);
    expect(body?.getAttribute('data-markdown-streaming')).toBe('true');
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    // A group finishing later must not reverse an already-running inner fold.
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} retainForGroupCollapse />));
    expect(panel.dataset.expanded).toBe('false');
    expect(panel.dataset.thinkingViewport).toBe(expanded ? 'expanded' : 'compact');
    await act(async () => toggle.click());
    expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({ thinkingItem: completed }));
    await act(async () => finish());
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(panel.dataset.thinkingViewport).toBe(expanded ? 'expanded' : 'compact');
    expect(container.querySelector('[data-testid="chat-thinking-toggle"]')).toBe(toggle);
  });

  it.each([false, true])('lets the completing group own the fold without reopening old thoughts (seven lines: %s)', async expanded => {
    const item = { ...summaryItem('Reasoning'), reasoningKind: 'reasoning' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} withinGroup />));
    if (expanded) await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    const body = container.querySelector('[data-testid="thinking-markdown"]');
    const completed = { ...item, isStreaming: false, status: 'completed' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} withinGroup retainForGroupCollapse />));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    expect(panel.dataset.expanded).toBe('true');
    expect(panel.dataset.streamingExpanded).toBeUndefined();
    expect(panel.dataset.thinkingViewport).toBe(expanded ? 'expanded' : 'compact');
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(body);
    // A different completed item must not inherit the outgoing body's lifetime.
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={{ ...completed, id: 'history' }} withinGroup retainForGroupCollapse />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')?.dataset.expanded).toBe('false');
  });

  it('replaces the collapsed preview when a new summary part arrives', async () => {
    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem('**First part**')} />);
    });
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('First part');

    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem(
        '**First part**\n\n**Second part**',
      )} />);
    });
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('Second part');
  });

  it('toggles a live summary inline and restores its single-line preview', async () => {
    const item = summaryItem('**First part**\n\n**Second part**');
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    await act(async () => (container.querySelector('.thinking-label-target') as HTMLElement).click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent).toBe(item.content);
    expect(openThinkingPanel).not.toHaveBeenCalled();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('Second part');
  });

  it.each([
    { withinGroup: false, displayContext: 'default' as const },
    { withinGroup: true, displayContext: 'default' as const },
    { withinGroup: false, displayContext: 'subagent-projection' as const },
  ])('keeps forced live reasoning compact and lets the reader toggle it: %j', async props => {
    const item = { ...summaryItem('Live reasoning'), reasoningKind: 'reasoning' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded {...props} />));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(panel.dataset.streamingExpanded).toBe('true');
    await act(async () => toggle.click());
    expect(panel.dataset.streamingExpanded).toBe('false');
    expect(openThinkingPanel).not.toHaveBeenCalled();
  });

  it.each([{ id: 'next-thought' }, { attemptId: 'retry', attemptIndex: 1 }])(
    'does not carry live expansion into another thought or retry: %j', async next => {
      const item = { ...summaryItem('Live reasoning'), reasoningKind: 'reasoning' as const };
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={{ ...item, ...next }} />));
      expect(container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')?.dataset.streamingExpanded).toBe('false');
    },
  );

  it('distinguishes an explicit search reveal from an automatic forceExpanded hint', async () => {
    const item = { ...summaryItem('Searchable reasoning'), reasoningKind: 'reasoning' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded />));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} forceExpanded revealStreamingContent />));
    expect(panel.dataset.streamingExpanded).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    expect(panel.dataset.streamingExpanded).toBe('false');
  });

  it('starts compact on a new device activation even when session and item IDs match', async () => {
    const originalSurface = getActiveSurfaceId();
    const item = { ...summaryItem('Live reasoning'), reasoningKind: 'reasoning' as const };
    try {
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      activateSurface('thinking-test-peer');
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} />));
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[data-testid="chat-thinking-toggle"]')).toBe(toggle);
    } finally { activateSurface(originalSurface); }
  });

  it('reveals a completed search match without discarding the reader collapse choice', async () => {
    const item = { ...summaryItem('Searchable reasoning'), reasoningKind: 'reasoning' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={item} withinGroup />));
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    const completed = { ...item, isStreaming: false, status: 'completed' as const };
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} withinGroup />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} withinGroup forceExpanded revealStreamingContent />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent).toBe(item.content);
    await act(async () => root.render(<ModelThinkingDisplay thinkingItem={completed} withinGroup />));
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
  });

  it('opens the completed summary in the panel while keeping its inline preview', async () => {
    const content = '**First part**\n\n**Second part**';
    const item = { ...summaryItem(content), isStreaming: false, status: 'completed' as const };
    await act(async () => {
      root.render(<FlowChatContext.Provider value={{ sessionId: 'source-session', workspaceId: 'workspace', workspacePath: '/srv/project', remoteConnectionId: 'ssh-1' }}>
        <div data-turn-id="source-turn"><ModelThinkingDisplay thinkingItem={item} /></div>
      </FlowChatContext.Provider>);
    });
    const leadingIcon = container.querySelector('[data-openbitfun-part="leadingIcon"]');
    const label = container.querySelector('[data-openbitfun-part="label"]');

    await act(async () => {
      (container.querySelector('.thinking-label-target') as HTMLElement).click();
    });
    expect(openThinkingPanel).toHaveBeenCalledWith({
      title: 'Thinking Summary', thinkingItem: item, sessionId: 'source-session',
      workspaceId: 'workspace', workspacePath: '/srv/project', remoteConnectionId: 'ssh-1',
      navigationTarget: { sessionId: 'source-session', turnId: 'source-turn', itemId: 'summary-1' },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')
      ?.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe('Second part');
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(leadingIcon);
    expect(container.querySelector('[data-openbitfun-part="label"]')).toBe(label);

    await act(async () => {
      root.render(<FlowChatContext.Provider value={{ sessionId: 'source-session' }}>
        <div data-turn-id="source-turn"><ModelThinkingDisplay thinkingItem={{ ...item, content: `${content}\n\n**Third part**` }} /></div>
      </FlowChatContext.Provider>);
    });
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')
      ?.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('Third part');
    expect(openThinkingPanel).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(leadingIcon);
  });

  it('keeps projected reasoning bound to its child stream and locates its parent task', async () => {
    await act(async () => root.render(<FlowChatContext.Provider value={{ sessionId: 'parent-session' }}>
      <div data-turn-id="parent-turn" data-flow-item-id="parent-task">
        <ModelThinkingDisplay thinkingItem={{ ...summaryItem('Child reasoning'), isStreaming: false, status: 'completed' }} sourceSessionId="child-session"
          displayContext="subagent-projection" />
      </div>
    </FlowChatContext.Provider>));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child-session',
      navigationTarget: { sessionId: 'parent-session', turnId: 'parent-turn', itemId: 'parent-task' },
    }));
  });
});

describe('ModelThinkingDisplay side completion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallbacks: Map<Element, () => void>;
  const panelSelector = '[data-testid="chat-thinking-panel"]';
  const toggleSelector = '[data-testid="chat-thinking-toggle"]';

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    revealState.isRevealing = false;
    resizeCallbacks = new Map();
    vi.stubGlobal('ResizeObserver', class {
      private targets = new Set<Element>();
      constructor(private callback: () => void) {}
      observe(target: Element) { this.targets.add(target); resizeCallbacks.set(target, this.callback); }
      unobserve(target: Element) { this.targets.delete(target); resizeCallbacks.delete(target); }
      disconnect() { this.targets.forEach(target => resizeCallbacks.delete(target)); }
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    revealState.isRevealing = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function render({ active = false, last = false, force = false, summary = false, withinGroup = false, content = 'A complete reasoning record', continuation = <p>The following answer</p> } = {}) {
    const item: FlowThinkingItem = {
      ...summaryItem(content),
      reasoningKind: summary ? 'summary' : 'reasoning',
      isStreaming: active,
      status: active ? 'streaming' : 'completed',
    };
    act(() => root.render(<>
      <ModelThinkingDisplay thinkingItem={item} isLastItem={last} forceExpanded={force} withinGroup={withinGroup} />
      {!last && <div data-thinking-continuation="">{continuation}</div>}
    </>));
    return container.querySelector(panelSelector)!;
  }

  it('keeps a completed thought attached when its next edit is in the next model round', async () => {
    const item: FlowThinkingItem = {
      ...summaryItem('A completed thought'), reasoningKind: 'reasoning',
      isStreaming: false, status: 'completed',
    };
    const rows = (showPeer: boolean, peerTurnId = 'turn') => <div className="virtual-message-list__items">
      <div className="virtual-item-wrapper" data-item-type="model-round" data-turn-id="turn">
        <div className="model-round-item" data-flow-item-stack="">
          <div data-thinking-continuation=""><p>Earlier edit</p></div>
          <ModelThinkingDisplay thinkingItem={item} isLastItem={false} />
        </div>
      </div>
      {showPeer && <div className="virtual-item-wrapper" data-item-type="model-round" data-turn-id={peerTurnId}>
        <div className="flowchat-timeline-content"><div className="model-round-item" data-flow-item-stack="">
          <div data-thinking-continuation="">
            <FileOperationToolCard actionLabel="Edit file" operation="edit" path="demo.html"
              pathLabel="demo.html" status="completed" />
          </div>
        </div></div>
      </div>}
    </div>;

    await act(async () => root.render(rows(false)));
    const panel = container.querySelector<HTMLElement>(panelSelector)!;
    const toggle = container.querySelector(toggleSelector);
    expect(panel.dataset.thinkingAttachment).toBe('block');

    await act(async () => root.render(rows(true)));
    const edit = container.querySelector<HTMLElement>('[data-thinking-side-target]')!;
    expect(container.querySelector(panelSelector)).toBe(panel);
    expect(container.querySelector(toggleSelector)).toBe(toggle);
    expect(panel.nextElementSibling).toBeNull();
    expect(panel.dataset.thinkingAttachment).toBe('side');
    expect(panel.dataset.thinkingPhase).toBe('side');
    expect(edit.hasAttribute('data-thinking-continuation')).toBe(true);
    expect(panel.dataset.thinkingActive).toBeUndefined();
    act(() => edit.dispatchEvent(new MouseEvent('mouseenter')));
    expect(panel.dataset.thinkingActive).toBe('true');

    await act(async () => root.render(rows(true, 'another-turn')));
    expect(panel.dataset.thinkingAttachment).toBe('block');
    expect(panel.dataset.thinkingActive).toBeUndefined();
    expect(edit.hasAttribute('data-thinking-side-target')).toBe(false);
  });

  it('gives consecutive cross-round thoughts separate hover owners', async () => {
    const firstThought: FlowThinkingItem = {
      ...summaryItem('First thought'), id: 'first-thought', reasoningKind: 'reasoning',
      isStreaming: false, status: 'completed',
    };
    const secondThought: FlowThinkingItem = { ...firstThought, id: 'second-thought', content: 'Second thought' };
    await act(async () => root.render(<div className="virtual-message-list__items">
      <div className="virtual-item-wrapper" data-item-type="model-round" data-turn-id="turn">
        <div className="model-round-item" data-flow-item-stack="">
          <div data-thinking-continuation="" data-card="edit"><p>Edit file</p></div>
          <ModelThinkingDisplay thinkingItem={firstThought} isLastItem={false} />
        </div>
      </div>
      <div className="virtual-item-wrapper" data-item-type="model-round" data-turn-id="turn">
        <div className="model-round-item" data-flow-item-stack="">
          <ModelThinkingDisplay thinkingItem={secondThought} isLastItem={false} />
          <div data-thinking-continuation="" data-card="answer"><p>Answer</p></div>
        </div>
      </div>
    </div>));

    const panels = container.querySelectorAll<HTMLElement>(panelSelector);
    expect(panels).toHaveLength(2);
    expect([...panels].map(panel => panel.dataset.thinkingAttachment)).toEqual(['side', 'side']);
    expect(container.querySelector('[data-card="edit"]')?.hasAttribute('data-thinking-side-target')).toBe(true);
    expect(container.querySelector('[data-card="answer"]')?.hasAttribute('data-thinking-side-target')).toBe(false);
    expect(panels[0].querySelector(toggleSelector)).not.toBe(panels[1].querySelector(toggleSelector));
    act(() => container.querySelector('[data-card="edit"]')?.dispatchEvent(new MouseEvent('mouseenter')));
    expect(panels[0].dataset.thinkingActive).toBe('true');
    expect(panels[1].dataset.thinkingActive).toBeUndefined();
  });

  it.each([false, true])('yields a compact preview to real output, retaining the disclosure (within group: %s)', withinGroup => {
    const panel = render({ active: true, last: true, withinGroup });
    const toggle = container.querySelector(toggleSelector);
    const content = container.querySelector('[data-testid="thinking-markdown"]');
    render({ active: true, withinGroup });
    const answer = container.querySelector('[data-thinking-continuation]');
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
    revealState.isRevealing = true;
    render({ withinGroup });
    expect(panel.getAttribute('data-expanded')).toBe('false');
    revealState.isRevealing = false;
    render({ withinGroup });
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector(panelSelector)).toBe(panel);
    expect(container.querySelector(toggleSelector)).toBe(toggle);
    expect(content).not.toBeNull();
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(container.querySelector('[data-thinking-continuation]')).toBe(answer);
  });

  it.each([false, true])('mounts completed history in its side state (within group: %s)', withinGroup => {
    const panel = render({ withinGroup });
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.getAttribute('data-scroll-owner')).toBe('self');
    const toggle = container.querySelector<HTMLElement>(toggleSelector)!;
    expect(toggle.getAttribute('aria-label')).toContain('Thought');
    expect(toggle.hasAttribute('title')).toBe(false);
    expect(toggle.querySelector('.thinking-capsule-label')).toBeNull();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('data-openbitfun-component')).toBe('icon-button');
    expect(toggle.getAttribute('data-openbitfun-variant')).toBe('quiet');
    expect(toggle.getAttribute('data-openbitfun-shape')).toBe('square');
    expect(toggle.getAttribute('data-size')).toBe('xs');
    expect(toggle.closest('[role="button"]')).toBeNull();
    expect(container.querySelector('[data-thinking-continuation]')?.getAttribute('style')).toBeNull();
    expect(toggle.tabIndex).toBe(0);
    expect(toggle.hasAttribute('aria-haspopup')).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    expect(container.querySelector('[data-openbitfun-part="expandContainer"]')?.hasAttribute('inert')).toBe(true);
  });

  it('keeps the reasoning count in the accessible icon name, including Unicode and summaries', () => {
    render({ content: '\u60f3\u{1f642}abc' });
    expect(container.querySelector(toggleSelector)?.getAttribute('aria-label')).toBe('Thought 5 characters');
    render({ summary: true, content: 'Summary' });
    expect(container.querySelector(toggleSelector)?.getAttribute('aria-label')).toBe('Thought 7 characters');
  });

  it.each([false, true])('opens the panel from keyboard activation without changing the chat (within group: %s)', async withinGroup => {
    const panel = render({ withinGroup });
    const toggle = container.querySelector<HTMLElement>(toggleSelector)!;
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    const successor = container.querySelector('[data-thinking-continuation]');
    toggle.focus();
    // Native keyboard activation emits a click with detail=0.
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true })));
    expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Thinking Process', thinkingItem: expect.objectContaining({ content: 'A complete reasoning record' }),
    }));
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    render({ withinGroup });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-thinking-continuation]')).toBe(successor);
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
    expect(document.activeElement).toBe(toggle);
    expect(container.querySelector('[data-testid="thinking-markdown"]')).toBeNull();
  });

  it.each([false, true])('keeps the tail accessible and honors forced expansion (within group: %s)', withinGroup => {
    const tail = render({ last: true, withinGroup });
    expect(tail.hasAttribute('data-thinking-attachment')).toBe(false);
    expect(tail.getAttribute('data-expanded')).toBe('false');
    act(() => container.querySelector<HTMLButtonElement>(toggleSelector)!.click());
    expect(openThinkingPanel).toHaveBeenCalledTimes(1);
    const panel = render({ force: true, withinGroup });
    expect(panel.getAttribute('data-expanded')).toBe('true');
    expect(panel.hasAttribute('data-thinking-attachment')).toBe(false);
  });

  it('retains a live summary label until it settles into the side button', () => {
    const panel = render({ active: true, summary: true, last: true });
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.hasAttribute('data-thinking-attachment')).toBe(false);
    render({ summary: true });
    expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
  });

  it('can explicitly reopen a completed thought after its successor has been presented', () => {
    const panel = render();
    expect(panel.getAttribute('data-expanded')).toBe('false');
    render({ force: true });
    expect(panel.getAttribute('data-expanded')).toBe('true');
    expect(panel.hasAttribute('data-thinking-exchange')).toBe(false);
    expect(container.querySelector('[data-testid="thinking-markdown"]')).not.toBeNull();
  });

  it.each(['edit', 'write'] as const)('centers on the %s header independently of expanded content', (operation) => {
    const panel = render({ continuation: <FileOperationToolCard
      actionLabel="Edit file" operation={operation} path="demo.html" pathLabel="demo.html"
      status="completed" isExpanded preview={<pre>File changes</pre>} onToggle={() => {}}
    /> }) as HTMLElement;
    const successor = container.querySelector<HTMLElement>('[data-thinking-continuation]')!;
    const header = successor.querySelector<HTMLElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]')!;
    let headerHeight = 36;
    let cardHeight = 44;
    vi.spyOn(successor, 'getBoundingClientRect').mockImplementation(() => ({ top: 100, height: cardHeight } as DOMRect));
    vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ top: 108, height: headerHeight } as DOMRect));
    act(() => successor.dispatchEvent(new MouseEvent('mouseenter')));
    act(() => resizeCallbacks.get(header)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('26px');

    cardHeight = 600;
    act(() => resizeCallbacks.get(successor)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('26px');

    headerHeight = 52;
    act(() => resizeCallbacks.get(header)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('34px');
    expect(successor.getAttribute('style')).toBeNull();
    expect(header.getAttribute('style')).toBeNull();

    render();
    act(() => resizeCallbacks.get(successor)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('');
    expect(resizeCallbacks.has(header)).toBe(false);
  });

  it('rebinds header alignment when a preceding card hides without remounting thinking', async () => {
    const item: FlowThinkingItem = {
      ...summaryItem('Reasoning'), reasoningKind: 'reasoning', isStreaming: false, status: 'completed',
    };
    const tree = (showRead: boolean, showEdit = true) => <>
      <ModelThinkingDisplay key="thinking" thinkingItem={item} isLastItem={false} />
      {showRead && <div key="read" data-thinking-continuation="" data-card="read"><p>Read file</p></div>}
      {showEdit && <div key="edit" data-thinking-continuation="" data-card="edit">
        <FileOperationToolCard actionLabel="Edit file" operation="edit" path="demo.html"
          pathLabel="demo.html" status="completed" />
      </div>}
      <div key="answer" data-thinking-continuation=""><p>Answer</p></div>
    </>;
    act(() => root.render(tree(true)));
    const panel = container.querySelector<HTMLElement>(panelSelector)!;
    const toggle = container.querySelector(toggleSelector);
    const oldSuccessor = container.querySelector<HTMLElement>('[data-card="read"]')!;
    const successor = container.querySelector<HTMLElement>('[data-card="edit"]')!;
    const header = successor.querySelector<HTMLElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]')!;
    vi.spyOn(successor, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 44 } as DOMRect);
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ top: 108, height: 36 } as DOMRect);
    expect(resizeCallbacks.has(oldSuccessor)).toBe(true);
    expect(resizeCallbacks.has(header)).toBe(false);

    await act(async () => { root.render(tree(false)); });
    expect(container.querySelector(panelSelector)).toBe(panel);
    expect(container.querySelector(toggleSelector)).toBe(toggle);
    expect(panel.nextElementSibling).toBe(successor);
    act(() => successor.dispatchEvent(new MouseEvent('mouseenter')));
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('26px');
    expect(resizeCallbacks.has(oldSuccessor)).toBe(false);
    expect(resizeCallbacks.has(header)).toBe(true);

    await act(async () => { root.render(tree(false, false)); });
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('');
    expect(resizeCallbacks.has(header)).toBe(false);
    expect(resizeCallbacks.has(successor)).toBe(false);
  });

  it.each([
    { name: 'paragraph', continuation: <p>Leading text</p>, top: 104, height: 16 },
    { name: 'bold heading', continuation: <h3><strong>Leading heading</strong></h3>, top: 100, height: 18 },
    { name: 'multiline text', continuation: <div>{'  Leading line\nSecond line\nThird line'}</div>, top: 106, height: 14 },
  ])('centers on the first rendered line of $name, independently of block height', ({ continuation, top, height }) => {
    const createRange = document.createRange.bind(document);
    const samples: string[] = [];
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => {
        samples.push(range.toString());
        return { top, height, width: 8 } as DOMRect;
      };
      return range;
    });
    const panel = render({ continuation }) as HTMLElement;
    const successor = container.querySelector<HTMLElement>('[data-thinking-continuation]')!;
    let blockHeight = 60;
    vi.spyOn(successor, 'getBoundingClientRect').mockImplementation(() => ({ top: 100, height: blockHeight } as DOMRect));
    act(() => successor.dispatchEvent(new MouseEvent('mouseenter')));
    act(() => resizeCallbacks.get(successor)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe(`${top - 100 + height / 2}px`);

    blockHeight = 600;
    act(() => resizeCallbacks.get(successor)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe(`${top - 100 + height / 2}px`);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(sample => Array.from(sample).length === 1)).toBe(true);
    expect(successor.getAttribute('style')).toBeNull();
  });

  it('updates the first-line anchor when streaming Markdown changes or replaces its leading text', async () => {
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => (
        range.startContainer.parentElement?.closest('h3')
          ? { top: 100, height: 18, width: 8 }
          : { top: 104, height: 20, width: 8 }
      ) as DOMRect;
      return range;
    });
    const panel = render({ continuation: <p>Paragraph</p> }) as HTMLElement;
    const successor = container.querySelector<HTMLElement>('[data-thinking-continuation]')!;
    const paragraph = successor.querySelector('p')!;
    const toggle = container.querySelector(toggleSelector);
    vi.spyOn(successor, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 300 } as DOMRect);
    act(() => successor.dispatchEvent(new MouseEvent('mouseenter')));
    act(() => resizeCallbacks.get(successor)!());
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('14px');

    await act(async () => { render({ continuation: <h3><strong>Heading</strong></h3> }); });
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('9px');
    expect(resizeCallbacks.has(paragraph)).toBe(false);
    expect(container.querySelector(toggleSelector)).toBe(toggle);

    const text = successor.querySelector('strong')!.firstChild as Text;
    await act(async () => { text.data = ''; });
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('');
    await act(async () => { text.data = 'Heading'; });
    expect(panel.style.getPropertyValue('--_thinking-continuation-center')).toBe('9px');
  });
});

describe('ModelThinkingDisplay tooltip lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallbacks: Map<Element, () => void>;
  const popup = () => document.querySelector('[role="tooltip"]');
  const reveal = () => {
    act(() => vi.advanceTimersByTime(500));
    act(() => vi.advanceTimersByTime(30));
  };
  const enter = (element: Element) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    element.dispatchEvent(new MouseEvent('mouseenter'));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  const leave = (element: Element) => act(() => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    element.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    revealState.isRevealing = false;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    resizeCallbacks = new Map();
    vi.stubGlobal('ResizeObserver', class {
      private targets = new Set<Element>();
      constructor(private callback: () => void) {}
      observe(target: Element) { this.targets.add(target); resizeCallbacks.set(target, this.callback); }
      unobserve(target: Element) { this.targets.delete(target); resizeCallbacks.delete(target); }
      disconnect() { this.targets.forEach(target => resizeCallbacks.delete(target)); }
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(summary = false) {
    await act(async () => root.render(<DesignSystemProvider nativeTooltipPolicy="application">
      <ModelThinkingDisplay isLastItem={false} thinkingItem={{
        ...summaryItem('A complete reasoning record'),
        reasoningKind: summary ? 'summary' : 'reasoning',
        isStreaming: false,
        status: 'completed',
      }} />
      <div data-thinking-continuation=""><p>The following answer</p></div>
    </DesignSystemProvider>));
    return container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
  }

  it.each([false, true])('does not revive a clicked tooltip after opening details or scrolling (summary: %s)', async (summary) => {
    const toggle = await render(summary);
    const body = container.querySelector('[data-testid="chat-thinking-content"]');
    enter(toggle);
    reveal();
    await act(async () => { toggle.focus(); toggle.click(); });
    leave(toggle);
    reveal();
    expect(popup()).toBeNull();
    expect(openThinkingPanel).toHaveBeenCalledTimes(1);

    act(() => container.dispatchEvent(new Event('scroll')));
    reveal();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(container.querySelector('[data-testid="chat-thinking-content"]')).toBe(body);

    enter(toggle);
    reveal();
    expect(popup()?.textContent).toBe('Thought 27 characters');
    leave(toggle);
    reveal();
    expect(popup()).toBeNull();
  });

  it('cancels a pending hover hint when clicked before its delay finishes', async () => {
    const toggle = await render();
    enter(toggle);
    await act(async () => { toggle.focus(); toggle.click(); });
    leave(toggle);
    act(() => container.dispatchEvent(new Event('scroll')));
    reveal();
    expect(popup()).toBeNull();
    expect(openThinkingPanel).toHaveBeenCalledTimes(1);
  });

  it('keeps retained label overflow separate from button focus and the side icon hint', async () => {
    const toggle = await render();
    const label = container.querySelector<HTMLElement>('.thinking-label')!;
    Object.defineProperty(label, 'clientWidth', { value: 12 });
    Object.defineProperty(label.firstElementChild, 'scrollWidth', { value: 160 });
    await act(async () => resizeCallbacks.get(label)!());
    act(() => container.dispatchEvent(new Event('scroll')));
    reveal();
    expect(popup()).toBeNull();

    const labelTarget = label.closest('label')!;
    enter(labelTarget);
    reveal();
    expect(popup()).toBeNull();
    leave(labelTarget);
    reveal();
    expect(popup()).toBeNull();

    await act(async () => { toggle.focus(); toggle.click(); });
    reveal();
    enter(toggle);
    reveal();
    expect(container.querySelector('.thinking-label')).toBe(label);
    expect(label.hasAttribute('data-overflow-tooltip')).toBe(false);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup()?.textContent).toBe('Thought 27 characters');
  });
});

describe.each([false, true])('ModelThinkingDisplay scroll ownership (within group: %s)', withinGroup => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let height: number;
  let viewport: number;
  let clockMs: number;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    frames = new Map();
    frameId = 0;
    height = 1000;
    viewport = 300;
    clockMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(content = 'Thinking') {
    act(() => root.render(<ModelThinkingDisplay thinkingItem={{
      ...summaryItem(content), reasoningKind: 'reasoning',
    }} withinGroup={withinGroup} />));
  }

  function nextFrame() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(clockMs)));
  }

  function startFollow(initialTop = 640) {
    render();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    const el = container.querySelector('[data-testid="chat-thinking-content"]') as HTMLDivElement;
    Object.defineProperties(el, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => viewport },
    });
    el.scrollTop = initialTop;
    nextFrame();
    expect(el.scrollTop).toBeGreaterThan(initialTop);
    expect(frames.size).toBe(1);
    return el;
  }

  it('stops scrolling in one-line mode and resumes the tail only when expanded again', () => {
    const el = startFollow();
    el.scrollTop = 400;
    act(() => el.dispatchEvent(new Event('scroll')));
    nextFrame();
    expect(frames.size).toBe(0);
    container.scrollTop = 120;
    viewport = 22;
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    nextFrame();
    expect(el.scrollTop).toBe(400);
    expect(container.scrollTop).toBe(120);
    height += 20;
    render('Newest reasoning');
    const previousTop = el.scrollTop;
    nextFrame();
    expect(el.scrollTop).toBe(previousTop);
    expect(frames.size).toBe(0);
    viewport = 154;
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!.click());
    nextFrame();
    expect(el.scrollTop).toBeGreaterThan(previousTop);
    expect(container.scrollTop).toBe(120);
  });

  it('does not start a scroll writer for initial single-line output or new lines', () => {
    render();
    const el = container.querySelector('[data-testid="chat-thinking-content"]') as HTMLDivElement;
    const writeScroll = vi.fn();
    Object.defineProperties(el, {
      scrollHeight: { get: () => height }, clientHeight: { get: () => 22 },
      scrollTop: { get: () => 0, set: writeScroll },
    });
    nextFrame();
    render('First line\nSecond line\nThird line');
    height += 44;
    nextFrame();
    expect(writeScroll).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(container.querySelector('[data-testid="chat-thinking-content"]')).toBe(el);
  });

  it.each([true, false])('pauses a scrollbar drag with scroll event delivered: %s', (deliverScroll) => {
    const el = startFollow();
    el.scrollTop = 400;
    if (deliverScroll) act(() => el.dispatchEvent(new Event('scroll')));
    nextFrame();
    expect(el.scrollTop).toBe(400);
    expect(frames.size).toBe(0);
    clockMs += 1000;
    height += 20;
    render('More thinking');
    nextFrame();
    expect(el.scrollTop).toBe(400);
  });

  it('continues following after its own scroll events', () => {
    const el = startFollow();
    const before = el.scrollTop;
    act(() => el.dispatchEvent(new Event('scroll')));
    nextFrame();
    expect(el.scrollTop).toBeGreaterThan(before);
  });

  it.each(['shrink', 'resize', 'rounding'])('does not pause for %s', (change) => {
    const el = startFollow();
    if (change === 'shrink') height -= 20;
    if (change === 'resize') viewport += 20;
    el.scrollTop -= change === 'rounding' ? 0.5 : 20;
    const before = el.scrollTop;
    act(() => el.dispatchEvent(new Event('scroll')));
    nextFrame();
    expect(el.scrollTop).toBeGreaterThan(before);
  });

  it.each([19, 20, 75])('only resumes within 20 px after the 700 ms pause (gap: %s)', (gap) => {
    const el = startFollow(690);
    const pausedTop = 700 - gap;
    el.scrollTop = pausedTop;
    act(() => el.dispatchEvent(new Event('scroll')));
    clockMs += 600;
    render('Still paused');
    nextFrame();
    expect(el.scrollTop).toBe(pausedTop);
    clockMs += 101;
    render('Resume near bottom');
    nextFrame();
    if (gap < 20) {
      expect(el.scrollTop).toBeGreaterThan(pausedTop);
    } else {
      expect(el.scrollTop).toBe(pausedTop);
    }
  });
});
