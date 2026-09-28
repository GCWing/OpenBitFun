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
      <ModelThinkingDisplay thinkingItem={item} isLastItem={last} />
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

it('keeps the same inline playback and reveal gate while opening the panel', () => {
  const h = setup();
  h.render('Start');
  const content = 'Start' + ' more'.repeat(200);
  h.render(content);
  const inlineBody = h.host.querySelector('[data-testid="body"]')!;
  expect(inlineBody.textContent).toBe('Start');
  h.toggle();
  expect(openThinkingPanel).toHaveBeenCalledWith(expect.objectContaining({
    thinkingItem: expect.objectContaining({ content }),
  }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(h.host.querySelector('[data-testid="body"]')).toBe(inlineBody);
  expect(h.host.querySelector('[data-testid="chat-thinking-panel"]')?.getAttribute('data-expanded')).toBe('true');
  expect(h.gate()).toBe('true');
  h.nextFrame();
  const afterOpen = inlineBody.textContent!;
  expect(afterOpen.length).toBeGreaterThan('Start'.length);
  expect(afterOpen.length).toBeLessThan(content.length);
  h.toggle();
  expect(openThinkingPanel).toHaveBeenCalledTimes(2);
  expect(h.host.querySelector('[data-testid="body"]')).toBe(inlineBody);
  expect(inlineBody.textContent).toBe(afterOpen);
  h.nextFrame();
  expect(inlineBody.textContent!.length).toBeGreaterThan(afterOpen.length);
  expect(h.gate()).toBe('true');
});

it('drains the stream before automatic docking after the panel was opened', () => {
  const h = setup();
  h.render('Start');
  h.toggle();
  const content = 'Start' + ' more'.repeat(200);
  h.render(content, false, false);
  const panel = h.host.querySelector('[data-testid="chat-thinking-panel"]')!;
  expect(h.gate()).toBe('true');
  expect(panel.getAttribute('data-expanded')).toBe('true');
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).toBe('Start');
  h.nextFrame();
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).not.toBe(content);
  for (let frame = 0; frame < 100 && h.gate() === 'true'; frame += 1) h.nextFrame();
  expect(h.gate()).toBe('false');
  expect(panel.getAttribute('data-expanded')).toBe('false');
  expect(panel.getAttribute('data-thinking-attachment')).toBe('side');
  expect(h.host.querySelector('[data-testid="body"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(openThinkingPanel).toHaveBeenCalledTimes(1);
});
