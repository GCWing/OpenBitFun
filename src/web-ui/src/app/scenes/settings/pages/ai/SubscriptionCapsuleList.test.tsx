// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubscriptionCapsuleList } from './SubscriptionCapsuleList';

const resize = vi.hoisted(() => ({ notify: () => {} }));
vi.mock('@/shared/utils/sharedResizeObserver', () => ({
  observeElementResize: (_element: Element, callback: () => void) => {
    resize.notify = callback;
    return () => { resize.notify = () => {}; };
  },
}));

let root: Root;
let container: HTMLDivElement;
let width: number;
const onMore = vi.fn();
const more = () => container.querySelector<HTMLButtonElement>('[data-testid="settings-subscription-more"] button')!;
const items = () => [...container.querySelectorAll<HTMLLIElement>('li[data-account]')];
const visible = () => items().filter(item => !item.hidden);
const render = (count: number, itemWidth = 100) => act(() => root.render(
  <SubscriptionCapsuleList label="Subscriptions" moreLabel="More" onMore={onMore}>
    {Array.from({ length: count }, (_, index) => <li key={index} data-account={index} data-width={itemWidth}>
      <button>Account {index}</button>
    </li>)}
  </SubscriptionCapsuleList>,
));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  width = 210;
  onMore.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const element = this as HTMLElement;
    const measuredWidth = element.tagName === 'UL' ? width
      : element.dataset.testid === 'settings-subscription-more' ? 60 : Number(element.dataset.width) || 0;
    return { width: measuredWidth, height: 32, x: 0, y: 0, top: 0, left: 0, right: measuredWidth, bottom: 32, toJSON() {} };
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('always shows the final More capsule, including a single account', () => {
  render(1);
  expect(visible()).toHaveLength(1);
  expect(more().getAttribute('aria-haspopup')).toBe('dialog');
  expect(more().closest('li')).toBe(container.querySelector('ul')?.lastElementChild);
  act(() => more().click());
  expect(onMore).toHaveBeenCalledOnce();
});

it('reserves room for More within three rows and restores entries after growing', () => {
  render(10);
  expect(visible()).toHaveLength(5);
  expect(items().slice(5).every(item => item.hidden)).toBe(true);
  width = 320;
  act(() => resize.notify());
  expect(visible()).toHaveLength(8);
  expect(items().slice(8).every(item => item.hidden)).toBe(true);
});

it('moves focus to More when a narrower container hides the focused account', () => {
  render(6);
  items()[3].querySelector('button')!.focus();
  width = 100;
  act(() => resize.notify());
  expect(visible()).toHaveLength(2);
  expect(document.activeElement).toBe(more());
});

it('recalculates when account labels or density change their widths', () => {
  render(3);
  expect(visible()).toHaveLength(3);
  render(3, 210);
  expect(visible()).toHaveLength(2);
});
