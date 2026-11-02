// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionViewTransition from './SessionViewTransition';
import type { WorkspaceSessionGrouping } from '../../workspaceSessionView';

interface Entry {
  id: string;
  top: number;
  header?: boolean;
  active?: boolean;
  collapsed?: boolean;
}

describe('session view transitions across replaced subtrees', () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollRootRef = createRef<HTMLDivElement>();
  let reducedMotion: boolean;
  let media: EventTarget;
  let offsets: WeakMap<Element, number>;
  let animations: Array<{
    element: HTMLElement;
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    cancel: ReturnType<typeof vi.fn>;
  }>;

  function render(grouping: WorkspaceSessionGrouping, entries: Entry[], surfaceId = 'local') {
    act(() => root.render(
      <div ref={scrollRootRef} data-scroll-root data-openbitfun-section="sessions">
        <button data-toggle>View</button>
        <div data-pinned-assistant>Assistant</div>
        <SessionViewTransition grouping={grouping} surfaceId={surfaceId} scrollRootRef={scrollRootRef}>
          <div key={grouping} data-layout={grouping}>
            {entries.map(entry => (
              <div key={entry.id} className={entry.collapsed ? 'is-collapsed' : ''}>
                <div
                  id={`row-${entry.id}`}
                  data-top={entry.top}
                  data-testid={entry.id}
                  data-session-id={entry.header ? undefined : entry.id}
                  data-workspace-id={entry.header ? entry.id : undefined}
                  data-session-active={entry.active ? 'true' : 'false'}
                  className={entry.header ? 'openbitfun-nav-panel__workspace-item-card' : 'openbitfun-nav-panel__inline-item'}
                >
                  <span className="openbitfun-nav-panel__inline-item-main">{entry.id}</span>
                  <button aria-controls={`menu-${entry.id}`}>Action</button>
                </div>
              </div>
            ))}
          </div>
        </SessionViewTransition>
      </div>,
    ));
  }

  const element = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const rowAnimation = (id: string) => animations.findLast(animation => animation.element === element(id))!;
  const layer = () => container.querySelector<HTMLElement>('.openbitfun-nav-panel__session-view-exits')!;

  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion = false;
    media = new EventTarget();
    offsets = new WeakMap();
    animations = [];
    vi.stubGlobal('matchMedia', () => Object.assign(media, { matches: reducedMotion }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-scroll-root')) return new DOMRect(0, 0, 280, 600);
      const row = this.closest<HTMLElement>('[data-top]');
      if (row) {
        const grouped = row.closest('[data-layout="grouped"]') !== null;
        const left = grouped ? 8 : 0;
        const copy = this.classList.contains('openbitfun-nav-panel__inline-item-main');
        return new DOMRect(left + (copy ? grouped ? 30 : 7 : 0),
          Number(row.dataset.top) - (scrollRootRef.current?.scrollTop ?? 0) + (offsets.get(row) ?? 0), 250, 30);
      }
      return new DOMRect(0, 0, 280, 600);
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
        const animation = { element: this, frames, options, cancel: vi.fn(() => offsets.delete(this)) };
        animations.push(animation);
        return animation;
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('moves the same sessions in both directions and animates the text rail independently', () => {
    render('grouped', [{ id: 'project', top: 0, header: true }, { id: 'a', top: 40, active: true }]);
    expect(animations).toHaveLength(0);
    const oldRow = element('a');
    const toggle = container.querySelector<HTMLButtonElement>('[data-toggle]')!;
    toggle.focus();
    render('all', [{ id: 'a', top: 0, active: true }]);

    expect(element('a')).not.toBe(oldRow);
    expect(rowAnimation('a').frames[0].transform).toBe('translate(8px, 40px)');
    expect(rowAnimation('a').options.duration).toBe(240);
    expect(animations.find(animation => animation.element === element('a').firstElementChild)?.frames[0].transform)
      .toBe('translateX(23px)');
    expect(element('a').dataset.sessionActive).toBe('true');
    expect(document.activeElement).toBe(toggle);
    expect(animations.some(animation => animation.element.hasAttribute('data-pinned-assistant'))).toBe(false);

    act(() => vi.advanceTimersByTime(280));
    render('grouped', [{ id: 'project', top: 0, header: true }, { id: 'a', top: 40, active: true }]);
    expect(rowAnimation('a').frames[0].transform).toBe('translate(-8px, -40px)');
    expect(rowAnimation('project').frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('fades outgoing titles and hidden sessions using inert copies, then removes them', () => {
    render('grouped', [{ id: 'project', top: 0, header: true }, { id: 'a', top: 40 }]);
    render('all', [{ id: 'b', top: 0 }]);
    expect(layer().getAttribute('aria-hidden')).toBe('true');
    expect(layer().hasAttribute('inert')).toBe(true);
    expect(layer().querySelector('[id], [data-session-id], [data-workspace-id], [data-testid], [aria-controls]')).toBeNull();
    expect(layer().textContent).toContain('project');
    expect(layer().textContent).toContain('a');
    expect(rowAnimation('b').options.duration).toBe(140);
    expect(animations.filter(animation => layer().contains(animation.element)).every(animation => animation.options.duration === 100)).toBe(true);
    act(() => vi.advanceTimersByTime(280));
    expect(layer().childElementCount).toBe(0);
    expect(container.querySelector('[data-openbitfun-state~="transitioning"]')).toBeNull();
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('fades large jumps and skips offscreen or collapsed rows', () => {
    render('grouped', [{ id: 'a', top: 0 }, { id: 'hidden', top: 30, collapsed: true }, { id: 'far', top: 2000 }]);
    render('all', [{ id: 'a', top: 420 }, { id: 'hidden', top: 450 }, { id: 'far', top: 1800 }]);
    expect(rowAnimation('a').frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(rowAnimation('hidden').frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animations.some(animation => animation.element === element('far'))).toBe(false);
  });

  it('reverses from the current visual position and cancels the old animations', () => {
    render('grouped', [{ id: 'a', top: 80 }]);
    render('all', [{ id: 'a', top: 0 }]);
    const firstAnimation = rowAnimation('a');
    offsets.set(element('a'), 25);
    element('a').style.opacity = '0.7';
    render('grouped', [{ id: 'a', top: 80 }]);
    expect(firstAnimation.cancel).toHaveBeenCalledOnce();
    expect(rowAnimation('a').frames[0]).toEqual({ transform: 'translate(-8px, -55px)', opacity: '0.7' });
  });

  it('does not replay on delayed catalog data or ordinary session updates', () => {
    render('grouped', [{ id: 'a', top: 40 }]);
    render('all', [{ id: 'a', top: 0 }]);
    const count = animations.length;
    render('all', [{ id: 'a', top: 0 }, { id: 'late', top: 30 }]);
    expect(animations).toHaveLength(count);
    expect(animations[0].cancel).not.toHaveBeenCalled();
  });

  it.each([false, true])('anchors the visible selected session with reduced motion = %s', reduced => {
    reducedMotion = reduced;
    render('grouped', [{ id: 'first', top: 120 }, { id: 'active', top: 240, active: true }]);
    const scroll = scrollRootRef.current!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 600 } });
    scroll.scrollTop = 100;
    render('all', [{ id: 'first', top: 120 }, { id: 'active', top: 400, active: true }]);
    expect(scroll.scrollTop).toBe(260);
    if (reduced) expect(animations).toHaveLength(0);
    else expect(rowAnimation('active').frames[0].transform).toBe('translate(8px, 0px)');
  });

  it('does not anchor to a session covered by the sticky header', () => {
    render('grouped', [{ id: 'covered', top: 110, active: true }, { id: 'visible', top: 240 }]);
    const scroll = scrollRootRef.current!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 600 } });
    scroll.scrollTop = 100;
    const header = document.createElement('div');
    header.dataset.openbitfunPart = 'stickySectionHeader';
    header.getBoundingClientRect = () => new DOMRect(0, 0, 280, 50);
    scroll.prepend(header);
    render('all', [{ id: 'covered', top: 300, active: true }, { id: 'visible', top: 280 }]);
    expect(scroll.scrollTop).toBe(140);
    header.remove();
  });

  it('clamps anchoring when the target list is too short to retain the old position', () => {
    render('all', [{ id: 'a', top: 400, active: true }]);
    const scroll = scrollRootRef.current!;
    Object.defineProperties(scroll, { scrollHeight: { value: 680 }, clientHeight: { value: 600 } });
    scroll.scrollTop = 100;
    render('grouped', [{ id: 'a', top: 500, active: true }]);
    expect(scroll.scrollTop).toBe(80);
  });

  it('uses the next surviving visible session when the selected one becomes hidden', () => {
    render('all', [{ id: 'active', top: 120, active: true }, { id: 'next', top: 240 }]);
    const scroll = scrollRootRef.current!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 600 } });
    scroll.scrollTop = 100;
    render('grouped', [{ id: 'active', top: 120, active: true, collapsed: true }, { id: 'next', top: 300 }]);
    expect(scroll.scrollTop).toBe(160);
  });

  it('leaves the top scroll position unchanged', () => {
    render('grouped', [{ id: 'a', top: 100, active: true }]);
    render('all', [{ id: 'a', top: 200, active: true }]);
    expect(scrollRootRef.current!.scrollTop).toBe(0);
  });

  it.each(['reduced', 'unavailable'] as const)('switches immediately when motion is %s', mode => {
    render('grouped', [{ id: 'a', top: 40 }]);
    if (mode === 'reduced') reducedMotion = true;
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate;
    render('all', [{ id: 'a', top: 0 }]);
    expect(animations).toHaveLength(0);
    expect(layer().childElementCount).toBe(0);
  });

  it('never carries an old device snapshot into a peer surface with the same session IDs', () => {
    render('grouped', [{ id: 'project', top: 0, header: true }, { id: 'a', top: 40 }]);
    render('all', [{ id: 'a', top: 0 }]);
    const count = animations.length;
    render('grouped', [{ id: 'a', top: 40 }], 'peer:other-host');
    expect(animations).toHaveLength(count);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(layer().childElementCount).toBe(0);
  });

  it.each(['scroll', 'resize', 'pointerdown', 'motion-preference'] as const)('settles immediately on %s', event => {
    render('grouped', [{ id: 'a', top: 40 }]);
    render('all', [{ id: 'a', top: 0 }]);
    act(() => {
      if (event === 'scroll') {
        scrollRootRef.current!.scrollTop = 1;
        scrollRootRef.current!.dispatchEvent(new Event('scroll'));
      } else if (event === 'resize') window.dispatchEvent(new Event('resize'));
      else if (event === 'motion-preference') media.dispatchEvent(new Event('change'));
      else element('a').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(container.querySelector('[data-openbitfun-state~="transitioning"]')).toBeNull();
  });

  it('cleans animations and timers when the navigation unmounts', () => {
    render('grouped', [{ id: 'a', top: 40 }]);
    render('all', [{ id: 'a', top: 0 }]);
    act(() => root.render(null));
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
