// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTodoClock } from './useTodoClock';

let root: Root;
let container: HTMLDivElement;
let hidden: boolean;
function Clock({ active }: { active: boolean }) {
  return <output>{useTodoClock(active)}</output>;
}
const render = (active: boolean) => act(() => root.render(<Clock active={active} />));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const read = () => Number(container.textContent);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T23:59:50Z'));
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps the existing 30-second cadence while visible', () => {
  render(true);
  const start = read();
  advance(29_999);
  expect(read()).toBe(start);
  advance(1);
  expect(read()).toBe(start + 30_000);
});

it('stops inactive ticks and catches up immediately on return across midnight', () => {
  render(true);
  const start = read();
  render(false);
  expect(vi.getTimerCount()).toBe(0);
  advance(120_000);
  expect(read()).toBe(start);
  render(true);
  expect(read()).toBe(start + 120_000);
  expect(vi.getTimerCount()).toBe(1);
});

it('suspends a hidden document and resumes without duplicate timers', () => {
  render(true);
  const start = read();
  hidden = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  advance(90_000);
  expect(read()).toBe(start);
  expect(vi.getTimerCount()).toBe(0);
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(read()).toBe(start + 90_000);
  expect(vi.getTimerCount()).toBe(1);
});

it('does not restart an inactive or unmounted scene when the document becomes visible', () => {
  render(false);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(vi.getTimerCount()).toBe(0);
  render(true);
  act(() => root.render(null));
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(vi.getTimerCount()).toBe(0);
});
