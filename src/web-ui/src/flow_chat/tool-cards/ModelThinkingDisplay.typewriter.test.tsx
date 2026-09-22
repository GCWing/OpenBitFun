// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelThinkingDisplay } from './ModelThinkingDisplay';
import type { FlowThinkingItem } from '../types/flow-chat';
import { TypewriterRevealGateContext, useCreateTypewriterRevealGate } from '../hooks/typewriterRevealGateContext';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@openbitfun/ui', () => ({
  OverflowText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
}));
vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="body">{content}</div>,
}));
vi.mock('./useToolCardHeightContract', () => ({
  useToolCardHeightContract: () => ({
    cardRootRef: { current: null },
    applyExpandedState: (_old: boolean, next: boolean, set: (next: boolean) => void) => set(next),
  }),
}));

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });

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
  function Card({ content, streaming = true }: { content: string; streaming?: boolean }) {
    const gate = useCreateTypewriterRevealGate();
    const item: FlowThinkingItem = {
      id: 'thinking', type: 'thinking', reasoningKind: 'reasoning', content,
      isStreaming: streaming, status: streaming ? 'streaming' : 'completed',
      timestamp: 1, isCollapsed: false,
    };
    return <TypewriterRevealGateContext.Provider value={gate}>
      <output data-testid="gate">{String(gate.isAnyRevealing)}</output>
      <ModelThinkingDisplay thinkingItem={item} />
    </TypewriterRevealGateContext.Provider>;
  }
  const render = (content: string, streaming = true) => act(() => root.render(<Card content={content} streaming={streaming} />));
  const toggle = () => act(() => (host.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement).click());
  return { host, frames, render, toggle, gate: () => host.querySelector('output')?.textContent };
}

it('keeps playback while closing, drains when hidden, and resumes only new text after reopening', async () => {
  const h = setup();
  h.render('Start');
  const content = 'Start' + ' more'.repeat(2000);
  h.render(content);
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).toBe('Start');
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const container = h.host.querySelector('[data-openbitfun-part="expandContainer"]')!;
  Object.defineProperty(container, 'getAnimations', { value: () => [{ transitionProperty: 'grid-template-rows', finished }] });
  h.toggle();
  expect(h.host.querySelector('[data-testid="body"]')).not.toBeNull();
  expect(h.gate()).toBe('true');
  await act(async () => { finish(); });
  expect(h.host.querySelector('[data-testid="body"]')).toBeNull();
  expect(h.gate()).toBe('false');
  expect(h.frames.size).toBe(0);
  const latest = content + ' hidden update';
  h.render(latest);
  expect(h.gate()).toBe('false');
  expect(h.frames.size).toBe(0);
  h.toggle();
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).toBe(latest);
  h.render(latest + ' next');
  expect(h.host.querySelector('[data-testid="body"]')?.textContent).toBe(latest);
  expect(h.gate()).toBe('true');
});

it('releases a finishing backlog immediately when collapsed without a transition', () => {
  const h = setup();
  h.render('Start');
  h.render('Start' + ' more'.repeat(2000), false);
  expect(h.gate()).toBe('true');
  h.toggle();
  expect(h.gate()).toBe('false');
  expect(h.frames.size).toBe(0);
  expect(h.host.querySelector('[data-testid="body"]')).toBeNull();
});
