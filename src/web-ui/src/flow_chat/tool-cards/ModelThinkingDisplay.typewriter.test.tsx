// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelThinkingDisplay } from './ModelThinkingDisplay';
import type { FlowThinkingItem } from '../types/flow-chat';
import { TypewriterRevealGateContext, useCreateTypewriterRevealGate } from '../hooks/typewriterRevealGateContext';
import { openThinkingPanel } from '../services/openThinkingPanel';

vi.mock('../services/openThinkingPanel', () => ({ openThinkingPanel: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/markdown', () => ({
  ThinkingMarkdownRenderer: ({ content }: { content: string }) => <div data-testid="body">{content}</div>,
}));
vi.mock('./useToolCardHeightContract', () => ({
  useToolCardHeightContract: () => ({
    cardRootRef: { current: null },
    dispatchToolCardToggle: vi.fn(),
    applyExpandedState: (_old: boolean, next: boolean, set: (next: boolean) => void) => set(next),
  }),
}));

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); vi.mocked(openThinkingPanel).mockClear(); });

function setup() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextId, cb); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  function Card({ content, streaming = true, last = true }: { content: string; streaming?: boolean; last?: boolean }) {
    const gate = useCreateTypewriterRevealGate();
    const item: FlowThinkingItem = {
      id: 'thinking', type: 'thinking', reasoningKind: 'reasoning', content,
      isStreaming: streaming, status: streaming ? 'streaming' : 'completed',
      timestamp: 1, isCollapsed: false,
    };
    return <TypewriterRevealGateContext.Provider value={gate}>
      <output data-testid="gate">{String(gate.isAnyRevealing)}</output>
      <ModelThinkingDisplay thinkingItem={item} isLastItem={last} forceExpanded={last && streaming} />
      {!last && <div data-thinking-continuation=""><p>Following answer</p></div>}
    </TypewriterRevealGateContext.Provider>;
  }
  const render = (content: string, streaming = true, last = true) => act(() => root.render(<Card content={content} streaming={streaming} last={last} />));
  const toggle = () => act(() => (host.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement).click());
  let now = performance.now();
  const nextFrame = () => act(() => {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
  });
  return { host, frames, render, toggle, nextFrame, gate: () => host.querySelector('output')?.textContent };
}

it('keeps playback and its reveal gate when toggling between one and seven live lines', () => {
  const h = setup();
  h.render('Start');
  const content = 'Start' + ' more'.repeat(200);
  h.render(content);
  const inlineBody = h.host.querySelector('[data-testid="body"]')!;
  const viewport = h.host.querySelector('[data-testid="chat-thinking-content"]')!;
  const panel = h.host.querySelector('[data-testid="chat-thinking-panel"]')!;
  const toggle = h.host.querySelector('[data-testid="chat-thinking-toggle"]')!;
  expect(inlineBody.textContent).toBe('Start');
  expect(panel.getAttribute('data-streaming-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(viewport.hasAttribute('inert')).toBe(true);
  act(() => (h.host.querySelector('.thinking-label-target') as HTMLElement).click());
  expect(panel.getAttribute('data-streaming-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(viewport.hasAttribute('inert')).toBe(false);
  expect(openThinkingPanel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(h.host.querySelector('[data-testid="body"]')).toBe(inlineBody);
  expect(h.host.querySelector('[data-testid="chat-thinking-panel"]')?.getAttribute('data-expanded')).toBe('true');
  expect(h.gate()).toBe('true');
  h.nextFrame();
  const afterOpen = inlineBody.textContent!;
  expect(afterOpen.length).toBeGreaterThan('Start'.length);
  expect(afterOpen.length).toBeLessThan(content.length);
  h.toggle();
  expect(panel.getAttribute('data-streaming-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(openThinkingPanel).not.toHaveBeenCalled();
  expect(h.host.querySelector('[data-testid="body"]')).toBe(inlineBody);
  expect(inlineBody.textContent).toBe(afterOpen);
  h.nextFrame();
  expect(inlineBody.textContent!.length).toBeGreaterThan(afterOpen.length);
  expect(h.gate()).toBe('true');
});

it('keeps seven lines through reveal, then folds directly into the completed details action', () => {
  const h = setup();
  h.render('Start');
  h.toggle();
  const content = 'Start' + ' more'.repeat(200);
  h.render(content, false, false);
  const panel = h.host.querySelector('[data-testid="chat-thinking-panel"]')!;
  expect(h.gate()).toBe('true');
  expect(panel.getAttribute('data-expanded')).toBe('true');
  expect(panel.getAttribute('data-streaming-expanded')).toBe('true');
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).toBe('Start');
  h.nextFrame();
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).not.toBe(content);
  for (let frame = 0; frame < 100 && h.gate() === 'true'; frame += 1) h.nextFrame();
  expect(h.gate()).toBe('false');
  expect(panel.hasAttribute('data-streaming-expanded')).toBe(false);
  expect(panel.getAttribute('data-thinking-viewport')).toBe('expanded');
  expect(panel.getAttribute('data-expanded')).toBe('false');
  expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
  expect(h.host.querySelector('[data-testid="body"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(openThinkingPanel).not.toHaveBeenCalled();
  h.toggle();
  expect(openThinkingPanel).toHaveBeenCalledTimes(1);
  expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({
    thinkingItem: expect.objectContaining({ content }),
  }));
  expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
});

it('starts compact when the same thought resumes after completion', () => {
  const h = setup();
  h.render('Reasoning');
  h.toggle();
  h.render('Reasoning', false, false);
  for (let frame = 0; frame < 10 && h.gate() === 'true'; frame += 1) h.nextFrame();
  h.render('Reasoning continues');
  const panel = h.host.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
  expect(panel.dataset.streamingExpanded).toBe('false');
  expect(panel.dataset.thinkingViewport).toBe('compact');
  expect(openThinkingPanel).not.toHaveBeenCalled();
});

it('hands a compact preview to an early successor without draining or flashing the remaining text', async () => {
  const h = setup();
  h.render('Painted preview');
  h.nextFrame();
  const panel = h.host.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
  const body = h.host.querySelector('[data-testid="body"]')!;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const expand = h.host.querySelector('.thinking-expand-container')!;
  Object.defineProperty(expand, 'getAnimations', {
    value: () => [{ transitionProperty: 'opacity', finished }],
  });
  const content = 'Painted preview' + ' backlog'.repeat(500);
  h.render(content, true, false);
  const successor = h.host.querySelector<HTMLElement>('[data-thinking-continuation]')!;
  // The gate now represents only the short handoff, not the text backlog.
  expect(h.gate()).toBe('true');
  expect(panel.dataset.expanded).toBe('false');
  expect(panel.dataset.thinkingExchange).toBe('closing');
  expect(successor.dataset.thinkingSuccessor).toBe('held');
  expect(body.textContent).toBe('Painted preview');
  h.nextFrame();
  expect(body.textContent).toBe('Painted preview');
  await act(async () => finish());
  expect(h.gate()).toBe('false');
  expect(successor.hasAttribute('data-thinking-successor')).toBe(false);
  expect(panel.dataset.thinkingExchange).toBe('released');
  h.toggle();
  expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({ thinkingItem: expect.objectContaining({ content }) }));
});

it.each([false, true])('closes completed trailing reasoning without waiting for a successor (seven lines: %s)', expanded => {
  const h = setup();
  h.render('Reasoning');
  if (expanded) h.toggle();
  h.render('Reasoning', false);
  for (let frame = 0; frame < 100 && h.gate() === 'true'; frame += 1) h.nextFrame();
  const panel = h.host.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
  expect(panel.dataset.expanded).toBe('false');
  expect(panel.dataset.thinkingViewport).toBe(expanded ? 'expanded' : 'compact');
  expect(h.host.querySelector('[data-testid="body"]')).toBeNull();
  h.toggle();
  expect(openThinkingPanel).toHaveBeenCalledTimes(1);
});
