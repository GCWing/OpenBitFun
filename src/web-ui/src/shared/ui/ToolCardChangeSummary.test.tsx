// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCardChangeSummary } from '@openbitfun/ui/flow-chat';

describe('ToolCardChangeSummary rolling counts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let now: number;
  let sequence: number;
  let reduced: boolean;
  let frames: Map<number, FrameRequestCallback>;
  let preferenceListeners: Set<() => void>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    now = 0;
    sequence = 0;
    reduced = false;
    frames = new Map();
    preferenceListeners = new Set();
    vi.spyOn(window.performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++sequence, callback);
      return sequence;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    vi.stubGlobal('matchMedia', () => ({
      matches: reduced,
      addEventListener: (_event: string, listener: () => void) => preferenceListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => preferenceListeners.delete(listener),
    }));
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      getPropertyValue: (name: string) => name === '--openbitfun-motion-duration-base' ? '240ms' : '',
    } as CSSStyleDeclaration));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(frames.size).toBe(0);
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (additions: number | string, animated = true) => act(() => root.render(
    <ToolCardChangeSummary additions={additions} deletions={0} animated={animated} />,
  ));
  const tick = (time: number) => act(() => {
    now = time;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(now));
  });
  const wheel = (place: number) => container.querySelector<HTMLElement>(
    `[data-openbitfun-change="added"] [data-digit-place="${place}"] > span`,
  )!;
  const position = (place: number) => Number(wheel(place).style.transform.match(/-([\d.]+)lh/)![1]);

  it('holds tens still until the units carry and keeps the latest count accessible', () => {
    render(18);
    const units = wheel(0);
    render(19);
    tick(120);
    expect(position(0)).toBeGreaterThan(8);
    expect(position(0)).toBeLessThan(9);
    expect(position(1)).toBe(1);
    tick(240);
    render(20);
    tick(360);
    expect(wheel(0)).toBe(units);
    expect(position(0)).toBeGreaterThan(9);
    expect(position(1)).toBeGreaterThan(1);
    expect(position(1)).toBeLessThan(2);
    expect(container.querySelector('[data-rolling-number="20"] > span:not([aria-hidden])')?.textContent).toBe('20');
    expect(wheel(0).closest('[aria-hidden="true"]')).not.toBeNull();
    tick(480);
    expect(position(0)).toBe(0);
    expect(position(1)).toBe(2);
  });

  it('carries through every place and retains host number formatting', () => {
    render('999');
    const units = wheel(0);
    render('1,000');
    tick(120);
    expect(wheel(0)).toBe(units);
    expect(position(3)).toBeGreaterThan(0);
    expect(position(3)).toBeLessThan(1);
    for (const place of [0, 1, 2]) expect(position(place)).toBeGreaterThan(9);
    tick(240);
    expect(position(3)).toBe(1);
    for (const place of [0, 1, 2]) expect(position(place)).toBe(0);
    expect(container.querySelector('[data-rolling-number]')?.getAttribute('data-rolling-number')).toBe('1,000');
  });

  it('retargets rapid batches from the visible position and snaps authoritative corrections', () => {
    render(10);
    render(15);
    tick(60);
    const visible = wheel(0).style.transform;
    render(27);
    expect(wheel(0).style.transform).toBe(visible);
    expect(frames.size).toBe(1);
    tick(300);
    expect(position(0)).toBe(7);
    expect(position(1)).toBe(2);
    render(4);
    expect(position(0)).toBe(4);
    expect(frames.size).toBe(0);
    render(5, false);
    expect(container.querySelector('[data-rolling-number]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+5');
  });

  it('stops active motion immediately when reduced motion is requested', () => {
    render(9);
    render(10);
    expect(frames.size).toBe(1);
    act(() => {
      reduced = true;
      preferenceListeners.forEach(listener => listener());
    });
    expect(frames.size).toBe(0);
    expect(container.querySelector('[data-rolling-number]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+10');
    render(20);
    expect(frames.size).toBe(0);
    expect(container.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+20');
  });
});
