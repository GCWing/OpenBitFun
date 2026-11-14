// @vitest-environment jsdom

import startupHtml from '../../../index.html?raw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STARTUP_OVERLAY_HIDDEN_EVENT } from './startupSignals';
import {
  getStartupOverlayElapsedMs,
  hideStartupOverlay,
  isStartupOverlayPresent,
} from './startupOverlay';

afterEach(() => {
  document.body.innerHTML = '';
  delete window.__OPENBITFUN_STARTUP_OVERLAY_STARTED_AT__;
  Reflect.deleteProperty(document, 'fonts');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startupOverlay', () => {
  it('releases startup state when the overlay has already been removed', async () => {
    document.body.innerHTML = '<div id="root" data-startup-stage="loading"></div>';
    await hideStartupOverlay();
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
  });

  it('removes the existing startup overlay when its exit animation completes', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root" data-startup-stage="loading"></div><div id="openbitfun-startup-overlay"></div>';

    const hidden = hideStartupOverlay();

    const overlay = document.getElementById('openbitfun-startup-overlay');
    expect(overlay?.classList.contains('openbitfun-startup-overlay--exiting')).toBe(true);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('root')?.getAttribute('data-startup-stage')).toBe('exiting');

    overlay?.dispatchEvent(new Event('animationend'));
    await hidden;

    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
  });

  it('releases startup-control focus before hiding the exiting overlay', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="openbitfun-startup-overlay">
        <button type="button" data-startup-window-action="close">Close</button>
      </div>
    `;
    const closeButton = document.querySelector<HTMLButtonElement>(
      '[data-startup-window-action="close"]',
    );
    closeButton?.focus();
    expect(document.activeElement).toBe(closeButton);

    const hidden = hideStartupOverlay();
    const overlay = document.getElementById('openbitfun-startup-overlay');

    expect(document.activeElement).not.toBe(closeButton);
    expect(overlay?.hasAttribute('inert')).toBe(true);
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');

    overlay?.dispatchEvent(new Event('animationend'));
    await hidden;
  });

  it('falls back to a timer when the exit animation event is not delivered', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root" data-startup-stage="loading"></div><div id="openbitfun-startup-overlay"></div>';

    const hidden = hideStartupOverlay();

    await vi.advanceTimersByTimeAsync(349);
    expect(isStartupOverlayPresent()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await hidden;

    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
  });

  it('tracks elapsed time from the static overlay first paint', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1500);
    window.__OPENBITFUN_STARTUP_OVERLAY_STARTED_AT__ = 1200;

    expect(getStartupOverlayElapsedMs()).toBe(300);
  });

  function mountWelcome(destination = new DOMRect(340, 260, 56, 56)) {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(callback, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    document.body.innerHTML = `
      <div id="root" data-startup-stage="loading"><section>
        <span data-startup-logo-target aria-hidden="true"></span>
        <span data-startup-reveal>OpenBitFun</span>
      </section></div>
      <div id="openbitfun-startup-overlay"><div class="splash-screen">
        <div class="splash-screen__logo-wrap"><span class="openbitfun-preload__logo"></span></div>
      </div></div>
    `;
    const overlay = document.getElementById('openbitfun-startup-overlay')!;
    const mark = overlay.querySelector<HTMLElement>('.openbitfun-preload__logo')!;
    const target = document.querySelector<HTMLElement>('[data-startup-logo-target]')!;
    // Include the current breathing scale rather than the nominal 120px size.
    vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(new DOMRect(500, 300, 119, 119));
    const measureTarget = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(destination);
    let complete!: () => void;
    let reject!: () => void;
    const finished = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
    const animation = { finished, cancel: vi.fn() };
    const animate = vi.fn(() => animation);
    Object.assign(mark, { animate });
    return { overlay, mark, target, measureTarget, animate, animation, complete, reject };
  }

  it.each([56, 48, 36])('moves the existing mark to the measured %ipx target and releases it once', async size => {
    const { overlay, mark, target, animate, animation, complete } = mountWelcome(new DOMRect(340, 260, size, size));
    const onHidden = vi.fn(() => expect(isStartupOverlayPresent()).toBe(false));
    window.addEventListener(STARTUP_OVERLAY_HIDDEN_EVENT, onHidden, { once: true });
    const hidden = hideStartupOverlay();
    expect(hideStartupOverlay()).toBe(hidden);
    expect(mark.parentElement).toBe(overlay);
    expect(mark.style.width).toBe('119px');
    expect(target.isConnected).toBe(true);
    expect(overlay.classList.contains('openbitfun-startup-overlay--handoff')).toBe(true);
    expect(document.getElementById('root')?.getAttribute('data-startup-stage')).toBe('handoff');
    expect(animate).toHaveBeenCalledWith([
      expect.objectContaining({ transform: 'translate(0px, 0px) scale(1, 1)' }),
      expect.objectContaining({ transform: `translate(-160px, -40px) scale(${size / 119}, ${size / 119})` }),
    ], expect.objectContaining({ duration: 420, fill: 'both' }));
    // Backdrop and text completion must not remove the still-moving mark.
    overlay.querySelector('.splash-screen')!.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(isStartupOverlayPresent()).toBe(true);
    complete();
    await hidden;
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['reduced-motion', 'inactive-scene', 'empty-slot', 'loading-font', 'missing-api'])('uses a dissolve for %s', async reason => {
    const { mark, target, measureTarget, animate } = mountWelcome();
    if (reason === 'reduced-motion') vi.stubGlobal('matchMedia', () => ({ matches: true }));
    if (reason === 'inactive-scene') target.parentElement!.setAttribute('inert', '');
    if (reason === 'empty-slot') measureTarget.mockReturnValue(new DOMRect());
    if (reason === 'loading-font') Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading' } });
    if (reason === 'missing-api') Object.assign(mark, { animate: undefined });
    const hidden = hideStartupOverlay();
    expect(animate).not.toHaveBeenCalled();
    expect(mark.parentElement?.className).toBe('splash-screen__logo-wrap');
    await vi.runAllTimersAsync();
    await hidden;
    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
  });

  it('restores the static mark if the WebView cannot create the animation', async () => {
    const { mark, animate } = mountWelcome();
    animate.mockImplementation(() => { throw new Error('Animation unavailable'); });
    const hidden = hideStartupOverlay();
    expect(mark.parentElement?.className).toBe('splash-screen__logo-wrap');
    expect(mark.getAttribute('style')).toBeNull();
    await vi.runAllTimersAsync();
    await hidden;
  });

  it.each(['resize', 'navigation', 'cancel'])('dissolves and cleans up an interrupted handoff: %s', async reason => {
    const { overlay, target, measureTarget, animation, reject } = mountWelcome();
    const hidden = hideStartupOverlay();
    if (reason === 'resize') measureTarget.mockReturnValue(new DOMRect(400, 260, 48, 48));
    if (reason === 'navigation') target.remove();
    if (reason === 'cancel') reject();
    await vi.advanceTimersByTimeAsync(16);
    expect(overlay.classList.contains('openbitfun-startup-overlay--handoff')).toBe(true);
    expect(document.getElementById('root')?.getAttribute('data-startup-stage')).toBe('handoff');
    expect(overlay.classList.contains('openbitfun-startup-overlay--interrupted')).toBe(true);
    expect(animation.cancel).toHaveBeenCalledOnce();
    overlay.dispatchEvent(new Event('animationend'));
    await hidden;
    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes when the WebView never resolves the animation promise', async () => {
    mountWelcome();
    const hidden = hideStartupOverlay();
    await vi.advanceTimersByTimeAsync(520);
    await hidden;
    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes without waiting for animation frames when the window becomes hidden', async () => {
    const { animation } = mountWelcome();
    const hidden = hideStartupOverlay();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await hidden;
    expect(isStartupOverlayPresent()).toBe(false);
    expect(document.getElementById('root')?.hasAttribute('data-startup-stage')).toBe(false);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the target logo hidden for the entire handoff, then reveals it with no DOM gap', async () => {
    const { target, complete } = mountWelcome();
    const style = document.createElement('style');
    style.textContent = startupHtml.match(/<style>([\s\S]*?)<\/style>/)![1];
    document.body.prepend(style);
    const hidden = hideStartupOverlay();
    expect(getComputedStyle(target).opacity).toBe('0');
    complete();
    await hidden;
    expect(getComputedStyle(target).opacity).not.toBe('0');
  });
});
