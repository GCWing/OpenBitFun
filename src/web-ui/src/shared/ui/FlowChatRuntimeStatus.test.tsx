// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowChatRuntimeStatus } from '@openbitfun/ui/flow-chat';

function pendingExit() {
  let finish!: () => void;
  let cancel!: () => void;
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve;
    cancel = () => reject(new Error('Transition cancelled'));
  });
  return { animation: { finished } as Animation, finish, cancel };
}

describe('resident runtime status playback', () => {
  let container: HTMLDivElement;
  let root: Root;
  let exitAnimations: Animation[];
  const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  const playback = { cancel: vi.fn(), pause: vi.fn(), play: vi.fn(), effect: null as unknown };
  const animate = vi.fn(() => playback);
  const getAnimations = vi.fn(function (this: Element) {
    return this.classList.contains('runtime-status-slot__content') ? exitAnimations : [];
  });
  const render = (visible: boolean) => act(() => root.render(<FlowChatRuntimeStatus label="Working" visible={visible} />));
  const spinner = () => container.querySelector<HTMLElement>('[data-openbitfun-component="spinner"]')!;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    exitAnimations = [];
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('IntersectionObserver', undefined);
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: getAnimations });
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount()); container.remove();
    if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
    else delete (Element.prototype as Partial<Element>).animate;
    if (originalGetAnimations) Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimations);
    else delete (Element.prototype as Partial<Element>).getAnimations;
    vi.unstubAllGlobals();
  });

  it('keeps the slot and playback through the real exit, then releases hidden work', async () => {
    render(false);
    const slot = container.firstElementChild;
    const icon = spinner();
    expect(animate).not.toHaveBeenCalled();
    render(true);
    expect(animate).toHaveBeenCalledTimes(1);
    const opacity = pendingExit(), movement = pendingExit();
    exitAnimations = [opacity.animation, movement.animation];
    render(false);
    expect(spinner()).toBe(icon);
    expect(icon.dataset.active).toBe('true');
    await act(async () => opacity.finish());
    expect(playback.cancel).not.toHaveBeenCalled();
    await act(async () => movement.finish());
    expect(icon.dataset.active).toBe('false');
    expect(playback.cancel).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild).toBe(slot);
    expect(getAnimations.mock.calls.every(args => args.length === 0)).toBe(true);
  });

  it('does not interrupt the glyph when a hidden exit is reversed', async () => {
    render(true);
    const exit = pendingExit(); exitAnimations = [exit.animation];
    render(false);
    render(true);
    await act(async () => exit.cancel());
    expect(animate).toHaveBeenCalledTimes(1);
    expect(playback.cancel).not.toHaveBeenCalled();
    expect(spinner().dataset.active).toBe('true');
    exitAnimations = [];
    render(false);
    expect(playback.cancel).toHaveBeenCalledTimes(1);
  });

  it('settles a cancelled exit and needs no timer when there is no transition', async () => {
    render(true);
    const exit = pendingExit(); exitAnimations = [exit.animation];
    render(false);
    await act(async () => exit.cancel());
    expect(spinner().dataset.active).toBe('false');
    expect(playback.cancel).toHaveBeenCalledTimes(1);
    render(true);
    exitAnimations = [];
    render(false);
    expect(spinner().dataset.active).toBe('false');
    expect(playback.cancel).toHaveBeenCalledTimes(2);
  });

  it('releases playback when unmounted during an exit', async () => {
    render(true);
    const exit = pendingExit(); exitAnimations = [exit.animation];
    render(false);
    act(() => root.render(null));
    expect(playback.cancel).toHaveBeenCalledTimes(1);
    await act(async () => exit.finish());
    expect(container.childElementCount).toBe(0);
    expect(playback.cancel).toHaveBeenCalledTimes(1);
  });
});
