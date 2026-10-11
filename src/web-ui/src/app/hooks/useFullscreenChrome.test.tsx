// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFullscreenChrome } from './useFullscreenChrome';
import type { NativeFullscreenChrome, NativeFullscreenPhase } from '@/infrastructure/runtime/fullscreenChrome';

const bridge = vi.hoisted(() => ({ subscribe: vi.fn(), unlisten: vi.fn() }));
vi.mock('@/infrastructure/runtime/fullscreenChrome', () => ({
  subscribeNativeFullscreenChrome: bridge.subscribe,
}));

function Chrome({ fullscreen }: { fullscreen: boolean }) {
  const { isFullscreenChrome } = useFullscreenChrome(fullscreen);
  return <span>{isFullscreenChrome ? 'compact' : 'reserved'}</span>;
}

describe('native fullscreen chrome timing', () => {
  let root: Root;
  let container: HTMLDivElement;
  let notify: (chrome: NativeFullscreenChrome) => void;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    vi.clearAllMocks();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    bridge.subscribe.mockImplementation(callback => {
      notify = callback;
      return bridge.unlisten;
    });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (fullscreen: boolean) => {
    await act(async () => root.render(<Chrome fullscreen={fullscreen} />));
  };
  const phase = async (value: NativeFullscreenPhase) => {
    await act(async () => notify({ phase: value }));
  };
  const paint = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(0));
    });
  };

  it('reserves space at willExit while native fullscreen still reports true', async () => {
    await render(true);
    expect(container.textContent).toBe('compact');
    await phase('exiting');
    expect(container.textContent).toBe('reserved');
    // Resize and command results may still report the old native state.
    await render(false);
    await render(true);
    expect(container.textContent).toBe('reserved');
    await phase('windowed');
    expect(container.textContent).toBe('reserved');
  });

  it('waits for didEnter before moving controls into the native titlebar space', async () => {
    await render(false);
    await phase('entering');
    await render(true);
    expect(container.textContent).toBe('reserved');
    await phase('fullscreen');
    expect(container.textContent).toBe('compact');
    await render(false); // A stale resize must not reverse the movement.
    expect(container.textContent).toBe('compact');
  });

  it('uses native state on startup and on hosts without phase notifications', async () => {
    await render(true);
    expect(container.textContent).toBe('compact');
    await render(false);
    expect(container.textContent).toBe('reserved');
    expect(bridge.subscribe).toHaveBeenCalledOnce();
  });

  it('handles consecutive transitions and cleans up on unmount', async () => {
    await render(false);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await phase('entering');
      expect(container.textContent).toBe('reserved');
      await phase('fullscreen');
      expect(container.textContent).toBe('compact');
      await phase('exiting');
      expect(container.textContent).toBe('reserved');
      await phase('windowed');
    }
    await act(async () => root.unmount());
    expect(bridge.unlisten).toHaveBeenCalledOnce();
  });

  it('keeps native buttons suppressed until movement finishes and the reserved layout paints', async () => {
    document.body.append(container);
    container.className = 'openbitfun-nav-bar--macos';
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const animations = vi.fn().mockReturnValue([{ transitionProperty: 'padding-left', finished }]);
    container.getAnimations = animations;
    const acknowledgePaint = vi.fn().mockResolvedValue(undefined);
    await render(true);
    await act(async () => notify({ phase: 'exiting', transitionId: 1, acknowledgePaint }));
    await paint();
    await paint();
    expect(acknowledgePaint).not.toHaveBeenCalled();
    animations.mockReturnValue([]);
    await act(async () => finish());
    await paint(); // Re-scan after animation.
    await paint(); // First frame can still be awaiting composition.
    expect(acknowledgePaint).not.toHaveBeenCalled();
    await paint();
    expect(acknowledgePaint).toHaveBeenCalledOnce();
  });

  it('acknowledges reduced motion after paint, but cancels a superseded exit', async () => {
    const acknowledgePaint = vi.fn().mockResolvedValue(undefined);
    await render(true);
    await act(async () => notify({ phase: 'exiting', transitionId: 1, acknowledgePaint }));
    await paint();
    await phase('entering');
    await paint();
    await paint();
    expect(acknowledgePaint).not.toHaveBeenCalled();
    await act(async () => notify({ phase: 'windowed', transitionId: 3, acknowledgePaint }));
    await paint();
    await paint();
    expect(acknowledgePaint).not.toHaveBeenCalled();
    await paint();
    expect(acknowledgePaint).toHaveBeenCalledOnce();
  });
});
