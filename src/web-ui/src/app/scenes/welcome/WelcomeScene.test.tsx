// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideStartupOverlay } from '@/app/startup/startupOverlay';
import { STARTUP_OVERLAY_HIDDEN_EVENT } from '@/app/startup/startupSignals';
import WelcomeScene from './WelcomeScene';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('welcome startup timing', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mountOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'openbitfun-startup-overlay';
    document.body.appendChild(overlay);
    return overlay;
  }

  function phrase() {
    return container.querySelector('.welcome-scene__typed-phrase')?.textContent;
  }

  it('keeps typing paused behind startup, then starts the first phrase after handoff', async () => {
    const overlay = mountOverlay();
    act(() => root.render(<WelcomeScene />));
    const scene = container.querySelector('section')!;
    expect(scene.hasAttribute('data-startup-entry')).toBe(true);
    expect(scene.hasAttribute('data-startup-pending')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(phrase()).toBe('');

    await act(async () => {
      const hidden = hideStartupOverlay();
      overlay.dispatchEvent(new Event('animationend'));
      await hidden;
    });
    expect(scene.hasAttribute('data-startup-pending')).toBe(false);
    // The normal welcome entrance must not replay when the overlay disappears.
    expect(scene.hasAttribute('data-startup-entry')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(449); });
    expect(phrase()).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(phrase()).toBe('w');
  });

  it('starts normally when welcome is opened after startup', async () => {
    act(() => root.render(<WelcomeScene />));
    expect(container.querySelector('section')?.hasAttribute('data-startup-entry')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(phrase()).toBe('w');
  });

  it('handles an overlay removed between rendering and effect subscription', async () => {
    const overlay = mountOverlay();
    function FinishDuringCommit() {
      useLayoutEffect(() => {
        overlay.remove();
        window.dispatchEvent(new CustomEvent(STARTUP_OVERLAY_HIDDEN_EVENT));
      }, []);
      return null;
    }
    act(() => root.render(<><WelcomeScene /><FinishDuringCommit /></>));
    expect(container.querySelector('section')?.hasAttribute('data-startup-pending')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(phrase()).toBe('w');
  });

  it('keeps the phrase static for reduced motion', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    act(() => root.render(<WelcomeScene />));
    const initial = phrase();
    expect(initial).toBe('welcomeScene.space.yourwelcomeScene.space.suffix');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(phrase()).toBe(initial);
  });

  it('switches the type scale through a width attribute, not container queries', () => {
    let notify: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof notify) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    act(() => root.render(<WelcomeScene />));
    const scene = container.querySelector('section')!;
    // jsdom lays out nothing, so a zero width must keep the regular tier.
    expect(scene.dataset.density).toBe('regular');

    // Startup or a resize can lay the scene out narrow before it widens.
    act(() => notify!([{ contentRect: { width: 360 } }]));
    expect(scene.dataset.density).toBe('tiny');
    act(() => notify!([{ contentRect: { width: 520 } }]));
    expect(scene.dataset.density).toBe('compact');
    act(() => notify!([{ contentRect: { width: 0 } }]));
    expect(scene.dataset.density).toBe('compact');
    act(() => notify!([{ contentRect: { width: 1200 } }]));
    expect(scene.dataset.density).toBe('regular');

    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalled();
    root = createRoot(container);
  });
});
