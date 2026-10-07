// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentDelegationAvatar } from './SubagentDelegationAvatar';
import { resolveSubagentAvatarPresentation } from './avatarResolver';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SubagentDelegationAvatar lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hidden: boolean;
  const tracks: { part?: string; duration?: number; cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  const originalMatchMedia = window.matchMedia;
  let reduced: MediaQueryList;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hidden = false;
    tracks.length = 0;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    reduced = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
    window.matchMedia = vi.fn(query => query.includes('prefers-reduced-motion')
      ? reduced : Object.assign(new EventTarget(), { matches: false }) as MediaQueryList);
    vi.stubGlobal('IntersectionObserver', undefined);
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: function (
      this: Element, _frames: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const cancel = vi.fn();
      tracks.push({ part: this.getAttribute('data-hatch-part') ?? undefined, duration: options.duration as number, cancel, finish });
      return { cancel, finished, play: vi.fn(), pause: vi.fn(), updatePlaybackRate: vi.fn(), playState: 'running' };
    } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(Element.prototype, 'animate');
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const hatchTracks = () => tracks.filter(track => track.part);
  const reveals = () => hatchTracks().filter(track => track.duration === 720);
  const phase = () => container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase');
  const render = (pending: boolean, sessionId?: string) => act(() => root.render(
    <SubagentDelegationAvatar pending={pending} sessionId={sessionId} status="running" showStatus={false} />,
  ));

  it('keeps its footprint and reveals the assigned avatar exactly once during live creation', async () => {
    render(true);
    const host = container.firstElementChild;
    const incubation = hatchTracks();
    expect(phase()).toBe('incubating');
    expect(incubation.length).toBeGreaterThan(0);
    expect(host?.getAttribute('style')).toContain('width: 32px; height: 32px');
    expect(container.querySelector('[data-openbitfun-avatar-id]')).toBeNull();

    render(false, 'actual-child');
    expect(container.firstElementChild).toBe(host);
    expect(phase()).toBe('ready');
    expect(incubation.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    expect(container.querySelector('[data-openbitfun-avatar-id]')?.getAttribute('data-openbitfun-avatar-id'))
      .toBe(resolveSubagentAvatarPresentation('actual-child').avatarId);
    const reveal = reveals();
    expect(reveal.some(track => track.part === 'avatar')).toBe(true);
    render(false, 'actual-child');
    expect(reveals()).toHaveLength(reveal.length);
    await act(async () => { reveal.forEach(track => track.finish()); });
    expect(reveal.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    expect(phase()).toBe('ready');
  });

  it('does not replay creation when an existing session mounts', () => {
    render(false, 'historical-child');
    expect(phase()).toBe('ready');
    expect(hatchTracks()).toHaveLength(0);
  });

  it.each(['error', 'cancelled', 'completed'] as const)('stops an unresolved %s creation, including late history hydration', status => {
    render(true);
    const incubation = hatchTracks();
    act(() => root.render(<SubagentDelegationAvatar pending={false} status={status} />));
    expect(phase()).toBe('stopped');
    expect(incubation.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    render(false, 'late-history-child');
    expect(phase()).toBe('ready');
    expect(reveals()).toHaveLength(0);
  });

  it('uses static states for reduced motion and never replays after preferences change', () => {
    Object.assign(reduced, { matches: true });
    render(true);
    render(false, 'child');
    expect(hatchTracks()).toHaveLength(0);
    act(() => {
      Object.assign(reduced, { matches: false });
      reduced.dispatchEvent(new Event('change'));
    });
    expect(phase()).toBe('ready');
    expect(reveals()).toHaveLength(0);
  });

  it('releases hidden loops and skips a creation that happens while the document is hidden', () => {
    render(true);
    const incubation = hatchTracks();
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    expect(incubation.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    render(false, 'child');
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(phase()).toBe('ready');
    expect(reveals()).toHaveLength(0);
  });

  it('releases offscreen loops and never defers a hatch until scrolling back', () => {
    const observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn>; target?: Element }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      disconnect = vi.fn();
      entry: typeof observers[number];
      observe = (target: Element) => { this.entry.target = target; };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnect: this.disconnect };
        observers.push(this.entry);
      }
    });
    const visibility = (value: boolean) => act(() => observers.filter(observer => (
      observer.target?.getAttribute('data-openbitfun-component') === 'subagent-hatch'
    )).at(-1)!.callback(
      [{ isIntersecting: value }] as IntersectionObserverEntry[], {} as IntersectionObserver,
    ));
    render(true);
    expect(hatchTracks()).toHaveLength(0);
    visibility(true);
    const incubation = hatchTracks();
    expect(incubation.length).toBeGreaterThan(0);
    visibility(false);
    expect(incubation.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    render(false, 'child');
    visibility(true);
    expect(reveals()).toHaveLength(0);
    act(() => root.unmount());
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
    root = createRoot(container);
  });
});
