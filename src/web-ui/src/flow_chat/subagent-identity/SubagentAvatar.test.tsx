// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subagentMotionClips } from '@openbitfun/ui/brand';
import { SubagentAvatar } from './SubagentAvatar';
import { resolveSubagentAvatarPresentation } from './avatarResolver';
import { getSubagentAvatarDefinition } from './catalog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SubagentAvatar', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(Element.prototype, 'animate');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the session-mapped SVG avatar and lifecycle state', () => {
    act(() => {
      root.render(
        <SubagentAvatar
          sessionId="child"
          name="parser-review"
          size={28}
          status="running"
        />,
      );
    });

    const avatar = container.querySelector('[data-openbitfun-component="subagent-avatar"]');
    const presentation = resolveSubagentAvatarPresentation('child');
    expect(avatar?.getAttribute('data-openbitfun-avatar-id')).toBe(presentation.avatarId);
    expect(avatar?.hasAttribute('data-openbitfun-avatar-color-id')).toBe(false);
    expect(avatar?.getAttribute('data-openbitfun-state')).toBe('running');
    expect(avatar?.getAttribute('style')).toContain('28px');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      getSubagentAvatarDefinition(presentation.avatarId).src,
    );
  });

  it('renders a stable avatar from the session ID before a name is assigned', () => {
    act(() => {
      root.render(
        <SubagentAvatar
          sessionId="restored-child-session"
          size={22}
          status="completed"
        />,
      );
    });

    const avatar = container.querySelector('[data-openbitfun-component="subagent-avatar"]');
    const presentation = resolveSubagentAvatarPresentation('restored-child-session');
    expect(avatar?.getAttribute('data-openbitfun-avatar-id')).toBe(presentation.avatarId);
    expect(avatar?.getAttribute('style')).toContain('--subagent-avatar-size: 22px');
    expect(avatar?.getAttribute('style')).not.toContain('hue-shift');
    expect(avatar?.hasAttribute('data-openbitfun-name-id')).toBe(false);
  });

  it('animates live completion once, without replaying it on a historical mount', () => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const animate = vi.fn((_keyframes: unknown, _options?: unknown) => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return { cancel, play: vi.fn(), pause: vi.fn(), updatePlaybackRate: vi.fn(), finished: new Promise(() => {}), playState: 'running' };
    });
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    vi.stubGlobal('IntersectionObserver', undefined);
    const render = (status: 'running' | 'completed') => act(() => root.render(
      <button data-agent-capsule-trigger><SubagentAvatar sessionId="child" status={status} motion showStatus={false} /></button>,
    ));
    render('completed');
    expect(animate.mock.calls.some(call => (call[1] as KeyframeAnimationOptions)?.duration === 520)).toBe(false);
    expect(container.querySelector('.subagent-avatar__status')).toBeNull();
    render('running');
    animate.mockClear();
    render('completed');
    expect(animate.mock.calls.filter(call => (call[1] as KeyframeAnimationOptions)?.duration === 520)).toHaveLength(4);
    act(() => root.render(null));
    expect(cancels.every(cancel => cancel.mock.calls.length > 0)).toBe(true);
  });

  it.each([
    ['pointerenter', 'pointerleave'],
    ['focus', 'blur'],
  ])('keeps working through %s and finishing, then responds to completion', async (enter, leave) => {
    const tracks: {
      options: KeyframeAnimationOptions;
      cancel: ReturnType<typeof vi.fn>;
      finish: () => void;
    }[] = [];
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: (
      _frames: Keyframe[], options: KeyframeAnimationOptions,
    ) => {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const cancel = vi.fn();
      tracks.push({ options, cancel, finish });
      return { cancel, finished, play: vi.fn(), pause: vi.fn(), playState: 'running' };
    } });
    vi.stubGlobal('IntersectionObserver', undefined);
    const render = (status: 'idle' | 'running' | 'finishing' | 'completed') => act(() => root.render(
      <button data-agent-capsule-trigger><SubagentAvatar sessionId="child" status={status} motion /></button>,
    ));
    const expectLoop = (duration: number) => {
      expect(tracks.slice(-4).map(track => [track.options.duration, track.options.iterations]))
        .toEqual(Array.from({ length: 4 }, () => [duration, Infinity]));
    };

    render('idle');
    const trigger = container.querySelector('button')!;
    act(() => { trigger.dispatchEvent(new Event(enter)); });
    expectLoop(subagentMotionClips.hoverBlink.duration);
    render('running');
    expectLoop(subagentMotionClips.working.duration);
    const workingTracks = tracks.slice(-4);
    const workingCount = tracks.length;
    act(() => {
      trigger.dispatchEvent(new Event(leave));
      trigger.dispatchEvent(new Event(enter));
    });
    render('finishing');
    expect(tracks).toHaveLength(workingCount);
    expect(workingTracks.every(track => track.cancel.mock.calls.length === 0)).toBe(true);

    render('completed');
    expect(workingTracks.every(track => track.cancel.mock.calls.length > 0)).toBe(true);
    expect(tracks.slice(-4).every(track => track.options.iterations === 1)).toBe(true);
    await act(async () => { tracks.slice(-4).forEach(track => track.finish()); });
    expectLoop(subagentMotionClips.hoverBlink.duration);

    render('running');
    act(() => { trigger.click(); });
    expect(tracks.slice(-4).every(track => track.options.iterations === 1)).toBe(true);
    await act(async () => { tracks.slice(-4).forEach(track => track.finish()); });
    expectLoop(subagentMotionClips.working.duration);
  });

  it('leaves the authored avatar static when reduced motion is requested', () => {
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    vi.stubGlobal('IntersectionObserver', undefined);
    const original = window.matchMedia;
    window.matchMedia = vi.fn(query => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList));
    try {
      act(() => root.render(<SubagentAvatar sessionId="child" status="running" motion />));
      act(() => root.render(<SubagentAvatar sessionId="child" status="completed" motion />));
      expect(animate).not.toHaveBeenCalled();
      expect(container.querySelector('[data-subagent-motion-art] svg')).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
