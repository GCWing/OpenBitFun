// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeferredContent, requestDeferredContentItem, type DeferredContentSegment } from '../src/deferredContent';

let container: HTMLDivElement;
let root: Root;
let intersect: (elements: Element[]) => void;
let observed: Set<Element>;
let observerRoot: Element | Document | null | undefined;
let disconnected: boolean;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observed = new Set();
  disconnected = false;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      observerRoot = options.root;
      intersect = elements => callback(elements.map(target => ({ target, isIntersecting: true } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
    }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { disconnected = true; observed.clear(); }
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ segments, onRevealItem, contained = true }: { segments: DeferredContentSegment[]; onRevealItem?: (id: string) => boolean; contained?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  return <div ref={viewport} data-viewport="">
    <DeferredContent viewportRef={contained ? viewport : undefined} segments={segments} segmentClassName="segment" label="Tools" onRevealItem={onRevealItem} />
  </div>;
}
function segments(count = 100): DeferredContentSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    key: String(index), memberIds: [`item-${index}`], estimatedHeightPx: 400, eager: index === 0,
    render: () => <><button data-item={index}>First</button><button>Last</button></>,
  }));
}

it.each([true, false])('mounts only eager and intersecting segments, then retains visited nodes (contained: %s)', contained => {
  act(() => root.render(<Harness contained={contained} segments={segments()} />));
  expect(container.querySelectorAll('[data-item]')).toHaveLength(1);
  expect(observed.size).toBe(99);
  expect(observerRoot).toBe(contained ? container.querySelector('[data-viewport]') : null);
  const first = container.querySelector<HTMLButtonElement>('[data-item="0"]')!;
  first.focus();
  const second = container.querySelectorAll<HTMLElement>('.segment')[1];
  expect(second.style.height).toBe('400px');
  act(() => intersect([second]));
  expect(container.querySelectorAll('[data-item]')).toHaveLength(2);
  expect(second.style.height).toBe('');
  expect(observed.has(second)).toBe(false);
  act(() => root.render(<Harness contained={contained} segments={segments()} />));
  expect(container.querySelector('[data-item="0"]')).toBe(first);
  expect(document.activeElement).toBe(first);
  expect(second.querySelector('[data-item="1"]')).not.toBeNull();
});

it('materializes a distant search source without mounting the intervening segments', () => {
  act(() => root.render(<Harness segments={segments()} />));
  act(() => { expect(requestDeferredContentItem(container, 'item-98')).toBe(true); });
  expect(container.querySelector('[data-item="98"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-item]')).toHaveLength(2);
  expect(requestDeferredContentItem(container, 'item-98')).toBe(false);
  expect(requestDeferredContentItem(container, 'missing')).toBe(false);
});

it('retains newly eager live content after it settles and releases observation on unmount', () => {
  const data = segments();
  act(() => root.render(<Harness segments={data} />));
  act(() => root.render(<Harness segments={data.map((segment, index) => index === 80 ? { ...segment, eager: true } : segment)} />));
  const live = container.querySelector('[data-item="80"]');
  expect(live).not.toBeNull();
  act(() => root.render(<Harness segments={data} />));
  expect(container.querySelector('[data-item="80"]')).toBe(live);
  act(() => root.render(null));
  expect(disconnected).toBe(true);
  expect(observed.size).toBe(0);
});

it.each([false, true])('hands keyboard entry to real controls (backward: %s)', backward => {
  act(() => root.render(<Harness segments={segments(3)} />));
  const placeholder = container.querySelectorAll<HTMLElement>('.segment')[1];
  const previous = document.createElement('button');
  if (backward) container.after(previous);
  else container.before(previous);
  previous.focus();
  act(() => placeholder.focus());
  const buttons = placeholder.querySelectorAll('button');
  expect(document.activeElement).toBe(backward ? buttons[1] : buttons[0]);
  expect(placeholder.tabIndex).toBe(-1);
  expect(container.querySelectorAll('[data-item]')).toHaveLength(2);
  previous.remove();
});

it('renders all content when intersection observation is unavailable', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  act(() => root.render(<Harness segments={segments(3)} />));
  expect(container.querySelectorAll('[data-item]')).toHaveLength(3);
});

it('does not observe hidden sources and asks the host to reveal retained or deferred navigation targets', () => {
  const data = segments(4);
  const reveal = vi.fn(() => true);
  const render = (hidden: boolean) => act(() => root.render(<Harness
    segments={data.map((segment, index) => ({ ...segment, hidden: hidden && index < 2 }))} onRevealItem={reveal} />));
  render(false);
  const first = container.querySelector('[data-item="0"]');
  render(true);
  const nodes = container.querySelectorAll<HTMLElement>('.segment');
  expect(nodes[0].hidden).toBe(true);
  expect(nodes[1].hidden).toBe(true);
  expect(observed.has(nodes[1])).toBe(false);
  act(() => intersect([nodes[1]]));
  expect(container.querySelector('[data-item="1"]')).toBeNull();
  expect(container.querySelector('[data-item="0"]')).toBe(first);
  act(() => { expect(requestDeferredContentItem(container, 'item-0')).toBe(true); });
  expect(reveal).toHaveBeenLastCalledWith('item-0');
  act(() => { expect(requestDeferredContentItem(container, 'item-1')).toBe(true); });
  expect(reveal).toHaveBeenLastCalledWith('item-1');
  render(false);
  expect(container.querySelector('[data-item="0"]')).toBe(first);
  expect(container.querySelector('[data-item="1"]')).not.toBeNull();
  expect(observed.size).toBe(2);
});
