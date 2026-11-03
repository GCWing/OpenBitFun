// @vitest-environment jsdom
import React, { act, StrictMode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySessionLoadingBoundary } from './HistorySessionLoadingBoundary';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { appearancePackageValidator } from '@/infrastructure/appearance/schema/AppearancePackageValidator';
import { modernFlowChatAppearanceDescriptor } from './appearance';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ControlledAnimation = {
  element: HTMLElement;
  frames: Keyframe[];
  finish: () => void;
  cancel: ReturnType<typeof vi.fn>;
};

describe('history loading presentation handoff', () => {
  let host: HTMLDivElement;
  let root: Root;
  let animations: ControlledAnimation[];
  let media: MediaQueryList;
  let reducedMotion: boolean;
  let hidden: boolean;
  const action = vi.fn();
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const transcript = (settled = true, content: React.ReactNode = 'Restored conversation') => (
    <div className="virtual-message-list" data-open-viewport-settled={String(settled)}>
      <div className="virtual-item-wrapper">{content}<button onClick={action}>Copy</button></div>
    </div>
  );
  function render(props: Partial<ComponentProps<typeof HistorySessionLoadingBoundary>> = {}) {
    act(() => root.render(<StrictMode>
      <HistorySessionLoadingBoundary identity="local:session-a" loading hasTranscript disabled={false}
        intent={false} label="Loading conversation" {...props}>
        {props.children ?? transcript()}
      </HistorySessionLoadingBoundary>
    </StrictMode>));
  }
  const element = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  const phase = () => element('[data-history-loading-phase]').dataset.historyLoadingPhase;
  async function finish(list = [...animations]) {
    await act(async () => { list.forEach(animation => animation.finish()); });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    animations = [];
    reducedMotion = false;
    hidden = false;
    action.mockReset();
    media = Object.assign(new EventTarget(), {
      media: '(prefers-reduced-motion: reduce)',
    }) as MediaQueryList;
    Object.defineProperty(media, 'matches', { get: () => reducedMotion });
    vi.stubGlobal('matchMedia', () => media);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.history-session-loading__content')) return new DOMRect(0, 0, 800, 600);
      if (this.matches('.virtual-item-wrapper')) return new DOMRect(32, 100, 736, 600);
      return new DOMRect(32, 174, 480, 24);
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
        let finish!: () => void;
        let reject!: (error: Error) => void;
        const finished = new Promise<void>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
        const cancel = vi.fn(() => reject(new DOMException('Cancelled', 'AbortError')));
        animations.push({ element: this, frames, finish, cancel });
        return { finished, cancel } as unknown as Animation;
      }),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits for the viewport owner after data arrives without measuring unsettled rows', async () => {
    render({ children: transcript(false) });
    render({ loading: false, children: transcript(false) });
    expect(phase()).toBe('loading');
    expect(animations).toHaveLength(0);
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('exiting');
    expect(animations.length).toBeGreaterThan(0);
  });

  it('preserves legacy appearance packages while keeping the old spinner invisible', () => {
    const legacyPackage = JSON.parse(JSON.stringify({
      schema: 'openbitfun.appearance', schemaVersion: 2, id: 'test.legacy-loading',
      name: 'Legacy loading appearance', version: '1.0.0', mode: 'light',
      components: {
        'modern-flow-chat': {
          parts: { historyOpenIntentSpinner: { base: { opacity: { kind: 'number', value: 0.5 } } } },
        },
      },
    }));
    const registry = new AppearanceRegistry().registerComponent(modernFlowChatAppearanceDescriptor).freeze();
    expect(appearancePackageValidator.validate(legacyPackage, registry).errors).toEqual([]);
    render({ intent: true });
    expect(element('[data-openbitfun-part="historyOpenIntentSpinner"]').hidden).toBe(true);
    const skeleton = element('.history-session-skeleton');
    render({ intent: false });
    expect(element('.history-session-skeleton')).toBe(skeleton);
  });

  it.each([
    ['text', <p key="text">A restored answer.</p>],
    ['tools', <section key="tools"><button>Read file · Complete</button></section>],
    ['code', <pre key="code">{'function restore() {\n  return history;\n}\n'.repeat(50)}</pre>],
  ])('finishes every abstract element before revealing %s, without remounting the content', async (_, content) => {
    render({ children: transcript(true, content) });
    const row = element('.virtual-item-wrapper');
    render({ loading: false, children: transcript(true, content) });
    const exits = [...animations];
    expect(exits).toHaveLength(8); // Seven normal-height lines and one user bubble.
    expect(element('.history-session-loading__content').style.opacity).toBe('0');
    expect(exits.every(animation => !animation.element.matches('.history-session-loading__content'))).toBe(true);
    await finish(exits.slice(0, -1));
    expect(phase()).toBe('exiting');
    expect(animations).toHaveLength(8);
    await finish(exits.slice(-1));
    expect(phase()).toBe('revealing');
    expect(element('.history-session-loading__overlay').hidden).toBe(true);
    expect(animations.at(-1)!.element).toBe(element('.history-session-loading__content'));
    for (const exit of exits) {
      expect(exit.frames.at(-1)?.opacity).toBe(0);
      // Only horizontal deformation is permitted: the lines never become thin.
      expect(exit.frames.every(frame => !('height' in frame) && !String(frame.transform).includes('scaleY'))).toBe(true);
    }
    await finish(animations.slice(-1));
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(element('.history-session-loading__content').style.opacity).toBe('');
    expect(element('.history-session-loading__content').style.maskImage).toBe('');
    expect(element('.virtual-item-wrapper')).toBe(row);
    expect(row.style.cssText).toBe('');
    expect(element('.virtual-message-list').scrollTop).toBe(0);
  });

  it('keeps invisible transcript actions unavailable throughout the retained transition', async () => {
    render();
    render({ loading: false });
    await finish();
    element('button').click();
    expect(action).not.toHaveBeenCalled();
    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    element('button').dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(element('.history-session-loading__content').getAttribute('aria-hidden')).toBe('true');
    await finish(animations.slice(-1));
    element('button').click();
    expect(action).toHaveBeenCalledOnce();
    expect(element('.history-session-loading__content').hasAttribute('aria-hidden')).toBe(false);
  });

  it('reports presentation only after the text reveal, and invalidates it on the next load', async () => {
    const presented = vi.fn();
    render({ onPresentationChange: presented });
    expect(presented).toHaveBeenLastCalledWith('local:session-a', false);
    presented.mockClear();
    render({ loading: false, onPresentationChange: presented });
    await finish();
    expect(presented).not.toHaveBeenCalled();
    await finish(animations.slice(-1));
    expect(presented).toHaveBeenLastCalledWith('local:session-a', true);
    render({ identity: 'peer:session-b', onPresentationChange: presented });
    expect(presented).toHaveBeenLastCalledWith('peer:session-b', false);
  });

  it('cancels stale animations when the session or device activation changes', async () => {
    render();
    render({ loading: false });
    const old = [...animations];
    render({ identity: 'peer:activation-2:session-a' });
    expect(old.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    await finish(old);
    expect(phase()).toBe('loading');
    expect(animations).toHaveLength(8);
    expect(element('.history-session-loading__content').style.opacity).toBe('0');
    render({ identity: 'peer:activation-2:session-a', loading: false });
    await finish(animations.slice(8));
    expect(phase()).toBe('revealing');
  });

  it('settles immediately when an opening is cancelled in favor of a warm session', async () => {
    render();
    render({ loading: false });
    const old = [...animations];
    render({ identity: 'local:session-b', loading: false });
    await finish(old);
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('replaces a running reveal with the next loading request without leaking text', async () => {
    render();
    render({ loading: false });
    await finish();
    const reveal = animations.at(-1)!;
    render();
    expect(reveal.cancel).toHaveBeenCalledOnce();
    expect(phase()).toBe('loading');
    expect(element('.history-session-loading__overlay').hidden).toBe(false);
    expect(element('.history-session-loading__content').style.maskImage).toBe('');
    expect(element('.history-session-loading__content').style.opacity).toBe('0');
  });

  it('exposes failure or inactive content immediately and ignores the former completion', async () => {
    render();
    render({ loading: false });
    render({ loading: false, disabled: true, hasTranscript: false, children: <button onClick={action}>Retry</button> });
    await finish();
    expect(phase()).toBe('idle');
    element('button').click();
    expect(action).toHaveBeenCalledOnce();
  });

  it('skips the handoff with reduced motion and settles if the preference changes mid-reveal', async () => {
    reducedMotion = true;
    render();
    render({ loading: false });
    expect(phase()).toBe('idle');
    expect(animations).toHaveLength(0);
    reducedMotion = false;
    render();
    render({ loading: false });
    await finish();
    act(() => { reducedMotion = true; media.dispatchEvent(new Event('change')); });
    expect(phase()).toBe('idle');
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('releases a hidden document without replaying when it becomes visible', async () => {
    render();
    render({ loading: false, children: transcript(false) });
    hidden = true;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(phase()).toBe('idle');
    expect(animations).toHaveLength(0);
  });

  it('does not replay on later streaming updates or virtual row remounts', async () => {
    render();
    render({ loading: false });
    await finish();
    await finish(animations.slice(-1));
    render({ loading: false, children: transcript(true, <pre key="new-row">New virtual window</pre>) });
    expect(phase()).toBe('idle');
    expect(animations).toHaveLength(9);
  });

  it('shows ready content if animation startup fails instead of retaining a shield', async () => {
    render();
    vi.mocked(HTMLElement.prototype.animate).mockImplementationOnce(() => { throw new Error('Animation unavailable'); });
    render({ loading: false });
    await act(async () => {});
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
