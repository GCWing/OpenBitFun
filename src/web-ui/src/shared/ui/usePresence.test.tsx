// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('overlay presence', () => {
  let root: Root;
  let host: HTMLDivElement;
  function Surface({ open }: { open: boolean }) {
    const { present, state } = usePresence(open, 100);
    return present ? <div data-state={state}>Surface</div> : null;
  }
  const render = (open: boolean) => act(() => root.render(<Surface open={open} />));
  beforeEach(() => {
    vi.useFakeTimers();
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: false });
    vi.stubGlobal('matchMedia', () => media);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancels entrance frames when dismissed and unmounts only after exit', () => {
    render(false);
    render(true);
    const surface = host.firstElementChild!;
    render(false);
    act(() => vi.advanceTimersByTime(99));
    expect(surface.getAttribute('data-state')).toBe('exiting');
    expect(surface.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
  });

  it('skips frame and exit delays when reduced motion is requested', () => {
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: true });
    vi.stubGlobal('matchMedia', () => media);
    render(false);
    render(true);
    expect(host.firstElementChild?.getAttribute('data-state')).toBe('entered');
    render(false);
    expect(host.childElementCount).toBe(0);
  });

  it('keeps an in-progress exit on its committed deadline when the motion preference changes', () => {
    const media = new EventTarget();
    let reduced = false;
    Object.defineProperty(media, 'matches', { get: () => reduced });
    vi.stubGlobal('matchMedia', () => media);
    render(true);
    act(() => vi.advanceTimersByTime(48));
    render(false);
    act(() => {
      vi.advanceTimersByTime(99);
      reduced = true;
      media.dispatchEvent(new Event('change'));
    });
    expect(host.childElementCount).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(host.childElementCount).toBe(0);
  });

  it('does not replay an entrance when reduced motion is disabled on an open surface', () => {
    const media = new EventTarget();
    let reduced = false;
    Object.defineProperty(media, 'matches', { get: () => reduced });
    vi.stubGlobal('matchMedia', () => media);
    render(true);
    act(() => vi.advanceTimersByTime(48));
    expect(host.firstElementChild?.getAttribute('data-state')).toBe('entered');
    act(() => { reduced = true; media.dispatchEvent(new Event('change')); });
    act(() => { reduced = false; media.dispatchEvent(new Event('change')); });
    expect(host.firstElementChild?.getAttribute('data-state')).toBe('entered');
  });

  it('keeps the ordinary exit lifecycle when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(true);
    act(() => vi.advanceTimersByTime(48));
    const surface = host.firstElementChild!;
    render(false);
    expect(surface.getAttribute('data-state')).toBe('exiting');
    expect(surface.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(surface.isConnected).toBe(false);
  });
});
