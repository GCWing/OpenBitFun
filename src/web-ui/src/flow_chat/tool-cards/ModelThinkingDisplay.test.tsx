// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowThinkingItem } from '../types/flow-chat';
import { ModelThinkingDisplay } from './ModelThinkingDisplay';

const markdownRender = vi.hoisted(() => vi.fn());

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
  useTypewriter: (content: string) => ({ displayText: content, isRevealing: false }),
}));

vi.mock('../hooks/typewriterRevealGateContext', () => ({
  useReportTypewriterReveal: () => {},
}));

vi.mock('./useToolCardHeightContract', () => ({
  useToolCardHeightContract: () => ({
    cardRootRef: { current: null },
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
  MarkdownRenderer: ({ content }: { content: string }) => {
    markdownRender(content);
    return <div data-testid="thinking-markdown">{content}</div>;
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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
      await act(async () => root.render(<ModelThinkingDisplay thinkingItem={summaryItem('**Body**')} />));
      const toggle = container.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement;
      await act(async () => toggle.click());
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
      await act(async () => toggle.click());
      expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(body);
      if (outcome === 'reopen') await act(async () => toggle.click());
      await act(async () => { if (outcome === 'finish') finish(); else cancel(); });
      expect(container.querySelector('[data-testid="thinking-markdown"]')).toBe(outcome === 'reopen' ? body : null);
    },
  );

  it('uses design-system thinking and disclosure icons in the header', async () => {
    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem('**Inspecting**')} />);
    });

    const leadingIcon = container.querySelector('[data-openbitfun-part="leadingIcon"]');
    expect(leadingIcon?.querySelector('[data-openbitfun-name="thinking"]')).not.toBeNull();
    expect(leadingIcon?.querySelector('[data-openbitfun-name="chevron-right"]')).not.toBeNull();
    expect(leadingIcon?.querySelector('[data-openbitfun-name="chevron-down"]')).not.toBeNull();
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

  it('keeps user expansion and renders the complete summary Markdown', async () => {
    const content = '**First part**\n\n**Second part**';
    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem(content)} />);
    });
    const leadingIcon = container.querySelector('[data-openbitfun-part="leadingIcon"]');
    const label = container.querySelector('[data-openbitfun-part="label"]');

    await act(async () => {
      (container.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')
      ?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe('Thinking Summary');
    expect(container.querySelector('[data-testid="thinking-markdown"]')?.textContent)
      .toBe(content);
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(leadingIcon);
    expect(container.querySelector('[data-openbitfun-part="label"]')).toBe(label);

    await act(async () => {
      root.render(<ModelThinkingDisplay thinkingItem={summaryItem(
        `${content}\n\n**Third part**`,
      )} />);
    });
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')
      ?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(leadingIcon);
  });
});

describe('ModelThinkingDisplay scroll ownership', () => {
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
    }} />));
  }

  function nextFrame() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(clockMs)));
  }

  function startFollow(initialTop = 640) {
    render();
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
