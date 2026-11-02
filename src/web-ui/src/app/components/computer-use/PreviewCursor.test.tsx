// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviewCursor } from './PreviewCursor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let now: number;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
let resize: () => void;
let motionChanged: () => void;
let reduced: boolean;
let width: number;

beforeEach(() => {
  now = 0; frameId = 0; frames = new Map(); reduced = false; width = 600;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback); return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { motionChanged = callback; },
    removeEventListener() {},
  }));
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(x: number, y: number, immediate = false) {
  await act(async () => root.render(<PreviewCursor x={x} y={y} immediate={immediate} />));
}
function advance(seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 120); i++) {
    now += 1000 / 120;
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(now));
  }
}
function position() {
  const span = container.querySelector('span')!;
  const [, x, y] = span.style.transform.match(/^translate3d\(([-\d.]+)px,([-\d.]+)px,0\)/)!;
  expect(span.style.left).toBe('');
  expect(span.style.top).toBe('');
  return { x: Number(x) + 4.8, y: Number(y) + 4.8 };
}

it('animates incoming preview coordinates without per-frame layout writes and settles', async () => {
  await render(0.1, 0.2);
  expect(position()).toEqual({ x: 60, y: 80 });
  expect(frames.size).toBe(0);
  await render(0.9, 0.8);
  advance(0.1);
  expect(position().x).not.toBe(60);
  expect(position().x).not.toBe(540);
  expect(frames.size).toBe(1);
  const before = position();
  // Initial/repeated ResizeObserver notifications must not restart the spring.
  resize();
  expect(position()).toEqual(before);
  advance(4);
  expect(position()).toEqual({ x: 540, y: 320 });
  expect(frames.size).toBe(0);
});

it('retargets from the current position, cancels old frames for direct manipulation and cleans up', async () => {
  await render(0.1, 0.2);
  await render(0.9, 0.8);
  advance(0.1);
  const before = position();
  await render(0.2, 0.7);
  expect(position()).toEqual(before);
  expect(frames.size).toBe(1);
  await render(0.5, 0.5, true);
  expect(position()).toEqual({ x: 300, y: 200 });
  expect(frames.size).toBe(0);
  await render(0.8, 0.2);
  expect(frames.size).toBe(1); // afterEach unmount must cancel it.
});

it('applies live reduced-motion changes and resizes without replaying an old position', async () => {
  await render(0.1, 0.2);
  await render(0.9, 0.8);
  advance(0.1);
  reduced = true; motionChanged();
  expect(position()).toEqual({ x: 540, y: 320 });
  expect(frames.size).toBe(0);
  await render(0.5, 0.5);
  expect(position()).toEqual({ x: 300, y: 200 });
  width = 300; resize();
  expect(position()).toEqual({ x: 150, y: 200 });
  expect(frames.size).toBe(0);
});

it('keeps animating when a same-frame retarget is newer than the pending RAF timestamp', async () => {
  await render(0.1, 0.2);
  await render(0.9, 0.8);
  advance(0.1);
  now += 4;
  await render(0.3, 0.6);
  const pending = [...frames.values()]; frames.clear();
  expect(() => pending.forEach(callback => callback(now - 3))).not.toThrow();
  expect(frames.size).toBe(1);
  advance(4);
  expect(position()).toEqual({ x: 180, y: 240 });
  expect(frames.size).toBe(0);
});
