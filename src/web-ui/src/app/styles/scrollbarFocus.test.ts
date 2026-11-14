// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retainScrollbarFocus } from '../../../../../design-system/packages/ui/src/internal/scrollbarFocus';

const attribute = 'data-openbitfun-focus-visible';
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
});
afterEach(() => {
  releases.splice(0).forEach(release => release());
  document.body.innerHTML = '';
  document.documentElement.removeAttribute(attribute);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('tracks native focus visibility without moving focus or reacting to streamed DOM', () => {
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  let visible = false;
  vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' && visible);
  releases.push(retainScrollbarFocus(document));
  const writes = vi.spyOn(document.documentElement, 'setAttribute');
  expect(document.documentElement.getAttribute(attribute)).toBe('false');
  visible = true;
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  vi.advanceTimersByTime(16);
  expect(document.documentElement.getAttribute(attribute)).toBe('true');
  expect(document.activeElement).toBe(button);
  expect(writes).toHaveBeenCalledTimes(1);

  document.body.append(document.createTextNode('New streamed text'));
  document.dispatchEvent(new Event('scroll'));
  button.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  vi.advanceTimersByTime(16);
  expect(writes).toHaveBeenCalledTimes(1);
  visible = false;
  button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  vi.advanceTimersByTime(16);
  expect(document.documentElement.getAttribute(attribute)).toBe('false');
});

it('shares listeners across owners and cancels pending work on final release', () => {
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');
  document.documentElement.setAttribute(attribute, 'previous');
  const first = retainScrollbarFocus(document), second = retainScrollbarFocus(document);
  releases.push(first, second);
  expect(added.mock.calls.filter(([name]) => name === 'focusin')).toHaveLength(1);
  first(); first();
  expect(removed).not.toHaveBeenCalled();
  document.dispatchEvent(new Event('focusin'));
  expect(vi.getTimerCount()).toBe(1);
  second();
  expect(vi.getTimerCount()).toBe(0);
  expect(removed.mock.calls.filter(([name]) => name === 'focusin')).toHaveLength(1);
  expect(document.documentElement.getAttribute(attribute)).toBe('previous');
});

it('reads the focused descendant of an open shadow root', () => {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const input = document.createElement('input');
  shadow.append(input); document.body.append(host); input.focus();
  vi.spyOn(input, 'matches').mockReturnValue(true);
  releases.push(retainScrollbarFocus(document));
  expect(document.activeElement).toBe(host);
  expect(document.documentElement.getAttribute(attribute)).toBe('true');
});
