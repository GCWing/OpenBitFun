// @vitest-environment jsdom
import React, { act, StrictMode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySessionLoadingBoundary } from './HistorySessionLoadingBoundary';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { appearancePackageValidator } from '@/infrastructure/appearance/schema/AppearancePackageValidator';
import { modernFlowChatAppearanceDescriptor } from './appearance';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('history loading presentation handoff', () => {
  let host: HTMLDivElement;
  let root: Root;
  let media: MediaQueryList;
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

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    hidden = false;
    action.mockReset();
    media = Object.assign(new EventTarget(), {
      media: '(prefers-reduced-motion: reduce)', matches: false,
    }) as MediaQueryList;
    vi.stubGlobal('matchMedia', () => media);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('.history-session-loading__content')) return new DOMRect(0, 0, 800, 600);
      if (this.matches('.virtual-item-wrapper')) return new DOMRect(32, 100, 736, 600);
      return new DOMRect(32, 174, 480, 24);
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(() => { throw new Error('Presentation must be immediate'); }),
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

  it('waits for the viewport owner and presents settled content immediately', async () => {
    render({ children: transcript(false) });
    render({ loading: false, children: transcript(false) });
    expect(phase()).toBe('loading');
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('waits for viewport settlement when a warm transcript mounts with complete data', async () => {
    const presented = vi.fn();
    render({ loading: false, children: transcript(false), onPresentationChange: presented });
    expect(phase()).toBe('loading');
    expect(presented).toHaveBeenLastCalledWith('local:session-a', false);
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
    expect(presented).toHaveBeenLastCalledWith('local:session-a', true);
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('presents a settled long answer with the user message outside the viewport', async () => {
    const content = <>
      <div className="user-message" data-turn-id="turn-a">Earlier question</div>
      <div className="answer">The visible end of a long answer</div>
    </>;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return this.matches('.user-message') ? new DOMRect(0, -2_000, 600, 40) : new DOMRect(0, 0, 600, 400);
    });
    render({ loading: false, children: transcript(false, content) });
    expect(phase()).toBe('loading');
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
    expect(element('.history-session-loading__content').style.opacity).toBe('');
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('waits for the new warm session viewport after changing session identity', async () => {
    render({ loading: false });
    expect(phase()).toBe('idle');
    render({ identity: 'local:session-b', loading: false, children: transcript(false) });
    expect(phase()).toBe('loading');
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
  });

  it('waits for a nested transcript mounted after the data commit', async () => {
    const placeholder = <div className="transcript-host" />;
    render({ children: placeholder });
    render({ loading: false, children: placeholder });
    expect(phase()).toBe('loading');
    await act(async () => {
      const list = document.createElement('div');
      list.className = 'virtual-message-list';
      list.dataset.openViewportSettled = 'true';
      element('.transcript-host').append(list);
    });
    expect(phase()).toBe('idle');
  });

  it.each([0, 140, 199, 200, 2_000])('presents a settled %d ms load without a post-load delay', elapsed => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    render();
    expect(element('.history-session-skeleton').style.animationDelay).toBe('200ms');
    clock.mockReturnValue(5_000 + elapsed);
    render({ loading: false });
    expect(phase()).toBe('idle');
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
    expect(element('.history-session-loading__content').style.opacity).toBe('');
    element('button').click();
    expect(action).toHaveBeenCalledOnce();
  });

  it('starts a fresh 200 ms indicator delay for a different session and a repeated load', () => {
    render();
    const initial = element('.history-session-skeleton');
    render({ identity: 'peer:session-b' });
    const next = element('.history-session-skeleton');
    expect(next).not.toBe(initial);
    expect(next.style.animationDelay).toBe('200ms');
    render({ identity: 'peer:session-b', loading: false });
    expect(phase()).toBe('idle');
    render({ identity: 'peer:session-b' });
    expect(element('.history-session-skeleton')).not.toBe(next);
    expect(element('.history-session-skeleton').style.animationDelay).toBe('200ms');
    render({ identity: 'peer:session-b', loading: false });
    expect(phase()).toBe('idle');
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
    ['code', <pre key="code">{'function restore() { return history; }'.repeat(50)}</pre>],
  ])('presents complete %s in one commit while retaining the content node', (_, content) => {
    render({ children: transcript(true, content) });
    const row = element('.virtual-item-wrapper');
    render({ loading: false, children: transcript(true, content) });
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(element('.history-session-loading__content').style.opacity).toBe('');
    expect(element('.virtual-item-wrapper')).toBe(row);
    expect(row.style.cssText).toBe('');
    expect(element('.virtual-message-list').scrollTop).toBe(0);
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });

  it('guards invisible transcript actions until viewport readiness', async () => {
    render();
    render({ loading: false, children: transcript(false) });
    element('button').click();
    expect(action).not.toHaveBeenCalled();
    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    element('button').dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(element('.history-session-loading__content').getAttribute('aria-hidden')).toBe('true');
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    element('button').click();
    expect(action).toHaveBeenCalledOnce();
    expect(element('.history-session-loading__content').hasAttribute('aria-hidden')).toBe(false);
  });

  it('reports presentation when the complete viewport settles and invalidates the next load', async () => {
    const presented = vi.fn();
    render({ onPresentationChange: presented });
    expect(presented).toHaveBeenLastCalledWith('local:session-a', false);
    presented.mockClear();
    render({ loading: false, onPresentationChange: presented, children: transcript(false) });
    expect(presented).not.toHaveBeenCalled();
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(presented).toHaveBeenLastCalledWith('local:session-a', true);
    render({ identity: 'peer:session-b', onPresentationChange: presented });
    expect(presented).toHaveBeenLastCalledWith('peer:session-b', false);
  });

  it('disconnects stale readiness observers when the session or device activation changes', async () => {
    render();
    render({ loading: false, children: React.cloneElement(transcript(false), { key: 'old' }) });
    const old = element('.virtual-message-list');
    render({ identity: 'peer:session-b', children: React.cloneElement(transcript(false), { key: 'new' }) });
    render({ identity: 'peer:session-b', loading: false,
      children: React.cloneElement(transcript(false), { key: 'new' }) });
    await act(async () => { old.dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('loading');
    expect(element('.history-session-loading__content').style.opacity).toBe('0');
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
  });

  it('settles immediately when an opening is cancelled in favor of a warm session', () => {
    render({ children: transcript(false) });
    render({ identity: 'local:session-b', loading: false });
    expect(phase()).toBe('idle');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('exposes failure or inactive content immediately', () => {
    render({ children: transcript(false) });
    render({ loading: false, disabled: true, hasTranscript: false, children: <button onClick={action}>Retry</button> });
    expect(phase()).toBe('idle');
    element('button').click();
    expect(action).toHaveBeenCalledOnce();
  });

  it('waits for a suspended viewport when its scene becomes active again', async () => {
    render({ loading: false, disabled: true, children: transcript(false) });
    expect(phase()).toBe('idle');
    render({ loading: false, disabled: false, children: transcript(false) });
    expect(phase()).toBe('loading');
    await act(async () => { element('.virtual-message-list').dataset.openViewportSettled = 'true'; });
    expect(phase()).toBe('idle');
  });

  it('uses the same delayed indicator and immediate settled presentation with reduced motion', () => {
    Object.defineProperty(media, 'matches', { value: true });
    render();
    expect(element('.history-session-skeleton').style.animationDelay).toBe('200ms');
    render({ loading: false });
    expect(phase()).toBe('idle');
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });

  it('releases a hidden document without replaying when it becomes visible', async () => {
    render();
    render({ loading: false, children: transcript(false) });
    hidden = true;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(phase()).toBe('idle');
  });

  it('keeps later streaming updates and virtual row remounts visible', () => {
    render();
    render({ loading: false });
    render({ loading: false, children: transcript(true, <pre key="new-row">New virtual window</pre>) });
    expect(phase()).toBe('idle');
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });
});
