import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { revealContainedRange, useContainedTailFollow } from '../src/scroll';

let container: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let height: number;
let paused: ReturnType<typeof vi.fn>;
let resize: (() => void)[];
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  resize = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize.push(callback); }
    observe() {} disconnect() {}
  });
  paused = vi.fn();
  height = 300;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness({ version, enabled = true }: { version: number; enabled?: boolean }) {
  const follow = useContainedTailFollow({ enabled, active: true, contentVersion: version, onUserPause: paused });
  return <div ref={follow.contentRef} {...follow.contentProps} style={{ overflowY: 'auto' }}><p>needle {version}</p></div>;
}
function drain() {
  for (let count = 0; frames.size && count < 60; count++) act(() => {
    const current = [...frames.values()]; frames.clear(); current.forEach(frame => frame(count * 16));
  });
}
function mount() {
  act(() => root.render(<Harness version={0} />));
  const viewport = container.firstElementChild as HTMLElement;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 300 }, scrollHeight: { get: () => height },
  });
  drain();
  return viewport;
}

it('follows appended output and child resizing only inside the bounded viewport', () => {
  const viewport = mount();
  container.scrollTop = 37;
  height = 360;
  act(() => root.render(<Harness version={1} />));
  drain();
  expect(viewport.scrollTop).toBe(60);
  height = 430;
  act(() => resize.forEach(callback => callback()));
  drain();
  expect(viewport.scrollTop).toBe(130);
  expect(container.scrollTop).toBe(37);
  act(() => root.render(<Harness version={2} enabled={false} />));
  expect(frames.size).toBe(0);
});

it('yields immediately to reading and resumes when the reader returns to the bottom', () => {
  const viewport = mount();
  height = 600;
  act(() => root.render(<Harness version={1} />));
  drain();
  act(() => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })));
  viewport.scrollTop = 100;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  height = 700;
  act(() => root.render(<Harness version={2} />));
  drain();
  expect(viewport.scrollTop).toBe(100);
  expect(paused).toHaveBeenCalled();
  const resumedAt = performance.now() + 1000;
  vi.spyOn(performance, 'now').mockReturnValue(resumedAt);
  viewport.scrollTop = 400;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  height = 740;
  act(() => root.render(<Harness version={3} />));
  drain();
  expect(viewport.scrollTop).toBe(440);
});

it('search reveals clipped inner text and cancels tail follow without moving the outer viewport', () => {
  const viewport = mount();
  height = 900;
  act(() => root.render(<Harness version={1} />));
  container.scrollTop = 48;
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 300));
  const range = document.createRange();
  range.selectNodeContents(viewport.querySelector('p')!);
  Object.defineProperty(range, 'getClientRects', { value: () => [new DOMRect(0, 600, 100, 20)] });
  act(() => revealContainedRange(range, container));
  expect(paused).toHaveBeenCalled();
  expect(viewport.scrollTop).toBe(360);
  drain();
  expect(viewport.scrollTop).toBe(360);
  expect(container.scrollTop).toBe(48);
});
