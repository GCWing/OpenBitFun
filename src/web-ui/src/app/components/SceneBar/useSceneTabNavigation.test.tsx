// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InteractionMotion } from '@/shared/utils/motionPreference';
import type { SceneTabId } from './types';
import { useSceneTabNavigation } from './useSceneTabNavigation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
let observer: ControlledResizeObserver;
let tabs: HTMLDivElement, region: HTMLDivElement;
let scrollTo: ReturnType<typeof vi.fn>;
let left: number;

class ControlledResizeObserver {
  observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) { observer = this; }
  deliver() { act(() => this.callback([], this as unknown as ResizeObserver)); }
}

function View({ active = 'session', motion = 'pointer' }: { active?: SceneTabId; motion?: InteractionMotion }) {
  const navigation = useSceneTabNavigation({ activeTabId: active, navigationMotion: motion,
    openTabIds: ['session', 'settings', 'git'] });
  return <div ref={navigation.tabRegionRef} data-region>
    <div ref={navigation.tabsRef} data-tabs onScroll={navigation.handleScroll} onWheel={navigation.handleWheel}>
      {['session', 'settings', 'git'].map(id => <div key={id} data-openbitfun-part="item">
        <button role="tab" data-openbitfun-value={id}>{id}</button>
      </div>)}
    </div>
    <button data-next onClick={() => navigation.scrollByPage(1)}>Next</button>
  </div>;
}

function render(active: SceneTabId = 'session', motion: InteractionMotion = 'pointer') {
  act(() => root.render(<View active={active} motion={motion} />));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  render();
  tabs = container.querySelector('[data-tabs]')!; region = container.querySelector('[data-region]')!;
  left = 0;
  Object.defineProperties(tabs, {
    clientWidth: { value: 180, configurable: true }, scrollWidth: { value: 620, configurable: true },
    scrollLeft: { get: () => left, set: value => { left = value; }, configurable: true },
  });
  Object.defineProperty(region, 'clientWidth', { value: 240 });
  const offsets = [0, 200, 420];
  vi.spyOn(tabs, 'getBoundingClientRect').mockImplementation(() => ({ left: 100, width: 180 } as DOMRect));
  [...tabs.children].forEach((item, index) => {
    Object.defineProperties(item, { offsetLeft: { value: 0 }, offsetWidth: { value: 100 } });
    vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() => ({ left: 100 + offsets[index] - left, width: 100 } as DOMRect));
  });
  scrollTo = vi.fn(({ left: value }: ScrollToOptions) => { left = value ?? left; });
  Object.defineProperty(tabs, 'scrollTo', { value: scrollTo });
  observer.deliver(); scrollTo.mockClear();
});

afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('reveals the activated tab in scroll coordinates and keeps pointer motion', () => {
  render('git');
  expect(scrollTo).toHaveBeenCalledWith({ left: 340, behavior: 'smooth' });
  observer.deliver();
  scrollTo.mockClear(); left = 0;
  observer.deliver();
  expect(scrollTo).not.toHaveBeenCalled(); // Later resizing does not override manual scroll position.
});

it('adjusts for an appearing edge control without restarting an unchanged smooth target', () => {
  render('git');
  expect(scrollTo).toHaveBeenCalledTimes(1);
  left = 50; // An intermediate smooth-scroll position.
  act(() => tabs.dispatchEvent(new Event('scroll')));
  observer.deliver();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  Object.defineProperty(tabs, 'clientWidth', { value: 148, configurable: true });
  observer.deliver();
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 372, behavior: 'smooth' });
  observer.deliver();
  scrollTo.mockClear(); left = 0; observer.deliver();
  expect(scrollTo).not.toHaveBeenCalled();
});

it('does not alternate between edges when a tab is wider than its viewport', () => {
  vi.spyOn(tabs.children[2], 'getBoundingClientRect').mockImplementation(() => ({ left: 520 - left, width: 300 } as DOMRect));
  render('git'); observer.deliver();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  act(() => tabs.dispatchEvent(new Event('scroll'))); observer.deliver();
  expect(scrollTo).toHaveBeenCalledTimes(1);
});

it('lets a newer keyboard activation replace an unfinished pointer reveal', () => {
  render('git'); left = 50; render('settings', 'instant');
  observer.deliver();
  expect(scrollTo).toHaveBeenCalledTimes(2);
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 120, behavior: 'auto' });
});

it('lets a wheel gesture supersede an unfinished activation reveal', () => {
  render('git');
  left = 50; scrollTo.mockClear();
  act(() => tabs.dispatchEvent(new WheelEvent('wheel', { deltaY: 72, bubbles: true, cancelable: true })));
  expect(left).toBe(122);
  observer.deliver();
  expect(scrollTo).not.toHaveBeenCalled();
  expect(left).toBe(122);
});

it('keeps reduced-motion activation instant and disconnects pending work on unmount', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  render('git'); observer.deliver();
  expect(scrollTo).toHaveBeenCalledWith({ left: 340, behavior: 'auto' });
  render('session'); scrollTo.mockClear();
  act(() => root.render(null));
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
  observer.deliver(); expect(scrollTo).not.toHaveBeenCalled();
});
