// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AmbientToolCard, AmbientToolCardHeader, ExploreGroup, ToolCapsulePresentationProvider, type FlowGroupReceiveFeedback } from '@openbitfun/ui/flow-chat';

type Status = 'running' | 'completed' | 'error';
let container: HTMLDivElement;
let root: Root;
let animations: { target: Element; cancelled: boolean; finish: () => void }[];
let reduce: boolean;
let listeners: Set<EventListener>;
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
const originalGetTotalLength = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getTotalLength');

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  animations = [];
  reduce = false;
  listeners = new Set();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('reduced-motion') && reduce; },
    addEventListener: (_: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_: string, listener: EventListener) => listeners.delete(listener),
  }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  // Geometry supplies visibility eligibility only, not visual-motion evidence.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const sample = this.closest<HTMLElement>('[data-motion-index]');
    const index = Number(sample?.dataset.motionIndex ?? 0);
    if (this.classList.contains('explore-region__content')) return new DOMRect(0, 32, 600, 350);
    if (this.classList.contains('explore-region__leading-icon')) return new DOMRect(8, 8, 16, 16);
    if (sample) return new DOMRect(8, 44 + index * 38, 160, 32);
    return new DOMRect(0, 0, 600, 400);
  });
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (this: Element) {
    let resolve!: () => void;
    const finished = new Promise<void>(done => { resolve = done; });
    if (this.closest('[data-openbitfun-component="openbitfun-brand-motion"]')) {
      return { finished, cancel: resolve, startTime: null };
    }
    const record = { target: this, cancelled: false, finish: resolve };
    animations.push(record);
    return { finished, cancel() { record.cancelled = true; resolve(); }, startTime: null };
  } });
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: () => 100 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  if (originalGetTotalLength) Object.defineProperty(SVGElement.prototype, 'getTotalLength', originalGetTotalLength);
  else Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function Capsule({ status = 'completed', index = 0 }: { status?: Status; index?: number }) {
  const [expanded, setExpanded] = useState(false);
  return <ToolCapsulePresentationProvider value={{ label: `file-${index}`, description: `Read file-${index} · ${status}`,
    statusLabel: status, status, expanded, onExpandedChange: setExpanded }}>
    <AmbientToolCard data-motion-index={index} status={status} onClick={() => {}}
      header={<AmbientToolCardHeader icon={<svg><path d="M0 0h10" /></svg>} content="Read" />}
      expandedContent={<p>Result and failure details</p>} />
  </ToolCapsulePresentationProvider>;
}

function Group({ count = 6, initialExpanded = true, receiveFeedback }: {
  count?: number; initialExpanded?: boolean; receiveFeedback?: FlowGroupReceiveFeedback;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  return <ExploreGroup expanded={expanded} itemCount={count} summary={`Read ${count}`} receiveFeedback={receiveFeedback} onToggle={() => setExpanded(value => !value)}>
    {Array.from({ length: count }, (_, index) => <Capsule key={index} index={index} status={index === 0 ? 'error' : 'completed'} />)}
  </ExploreGroup>;
}

it('keeps history mounts still and preserves the control and failure record through a live rupture', () => {
  act(() => root.render(<Capsule status="running" />));
  const button = container.querySelector('button')!;
  expect(animations).toHaveLength(0);
  act(() => root.render(<Capsule status="error" />));
  expect(container.querySelector('button')).toBe(button);
  expect(button.getAttribute('aria-label')).toContain('error');
  expect(container.querySelector('[data-capsule-decoration]')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('[data-capsule-decoration]')?.children).toHaveLength(2);
  act(() => button.click());
  expect(container.textContent).toContain('Result and failure details');
  expect(container.querySelector('[data-capsule-decoration]')).toBeNull();
  expect(animations.slice(0, 3).every(animation => animation.cancelled)).toBe(true);
});

it('does not burst an error when a historical capsule mounts', () => {
  act(() => root.render(<Capsule status="error" />));
  expect(animations).toHaveLength(0);
  expect(container.textContent).toContain('error');
});

it('collapses without decorative motion and preserves the cards on rapid reopen', () => {
  act(() => root.render(<Group />));
  const toggle = container.querySelector<HTMLElement>('[data-testid="chat-explore-group-toggle"]')!;
  const cards = [...container.querySelectorAll('[data-tool-capsule="true"]')];
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[data-capsule-decoration]')).toBeNull();
  expect(animations).toHaveLength(0);
  act(() => toggle.click());
  expect(container.querySelector('[data-capsule-decoration]')).toBeNull();
  expect(animations).toHaveLength(0);
  expect([...container.querySelectorAll('[data-tool-capsule="true"]')]).toEqual(cards);
  expect(container.textContent).toContain('Read 6');
});

it('releases all decorations and media listeners when failure feedback finishes', async () => {
  act(() => root.render(<Capsule status="running" />));
  act(() => root.render(<Capsule status="error" />));
  expect(container.querySelector('[data-capsule-decoration]')).not.toBeNull();
  await act(async () => { animations.forEach(animation => animation.finish()); await Promise.resolve(); });
  expect(container.querySelector('[data-capsule-decoration]')).toBeNull();
  expect(container.querySelector('[data-capsule-motion]')).toBeNull();
  expect(listeners.size).toBe(0);
});

it('cancels in-flight motion if reduced motion is enabled and still allows disclosure', () => {
  act(() => root.render(<Capsule status="running" />));
  act(() => root.render(<Capsule status="error" />));
  const toggle = container.querySelector('button')!;
  expect(animations.length).toBeGreaterThan(0);
  reduce = true;
  act(() => [...listeners].forEach(listener => listener(new Event('change'))));
  expect(container.querySelector('[data-capsule-decoration]')).toBeNull();
  expect(animations.every(animation => animation.cancelled)).toBe(true);
  const count = animations.length;
  act(() => toggle.click());
  act(() => toggle.click());
  expect(animations).toHaveLength(count);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('coalesces explicit background receipts while count-only changes remain still', () => {
  const receipt = () => {
    let claimed = false;
    return { claim: () => { if (claimed) return false; claimed = true; return true; } };
  };
  act(() => root.render(<Group initialExpanded={false} count={2} />));
  expect(animations).toHaveLength(0);
  act(() => root.render(<Group initialExpanded={false} count={3} />));
  expect(animations).toHaveLength(0);
  act(() => root.render(<Group initialExpanded={false} count={3} receiveFeedback={receipt()} />));
  expect(animations).toHaveLength(1);
  act(() => root.render(<Group initialExpanded={false} count={8} receiveFeedback={receipt()} />));
  expect(animations).toHaveLength(1);
  expect(container.textContent).toContain('Read 8');
});

it('cleans up a running motion when its owning view unmounts', () => {
  act(() => root.render(<Capsule status="running" />));
  act(() => root.render(<Capsule status="error" />));
  act(() => root.render(null));
  expect(animations.every(animation => animation.cancelled)).toBe(true);
  expect(listeners.size).toBe(0);
});
