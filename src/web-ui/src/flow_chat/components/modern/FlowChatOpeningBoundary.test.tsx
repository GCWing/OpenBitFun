// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowChatOpeningBoundary } from './FlowChatOpeningBoundary';
import { Portal } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('FlowChat opening interaction boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  const action = vi.fn();
  const focused = vi.fn();
  function render(opening = true) {
    act(() => root.render(<>
      <button data-before>Before</button>
      <FlowChatOpeningBoundary opening={opening} data-transcript>
        <button data-inside onClick={action} onFocus={focused}>Message action</button>
      </FlowChatOpeningBoundary>
      <button disabled>Disabled</button>
      <div hidden><button>Hidden</button></div>
      <div aria-hidden="true"><button>Accessibility hidden</button></div>
      <input data-after />
    </>));
  }
  const element = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  function tab(shiftKey: boolean, destination: string) {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey, bubbles: true, cancelable: true,
    }));
    // jsdom does not implement the browser's default Tab traversal.
    element(destination).focus();
  }
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    action.mockReset();
    focused.mockReset();
    // Supply boxes solely for tabbable's visibility filter, not layout validation.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('skips the transcript in both Tab directions without focusing message controls', () => {
    render();
    element('[data-before]').focus();
    tab(false, '[data-flowchat-opening-guard="before"]');
    expect(document.activeElement).toBe(element('[data-after]'));
    tab(true, '[data-flowchat-opening-guard="after"]');
    expect(document.activeElement).toBe(element('[data-before]'));
    expect(focused).not.toHaveBeenCalled();
  });

  it('redirects a positive-tabindex control that bypasses a guard', () => {
    render();
    element('[data-inside]').tabIndex = 1;
    element('[data-before]').focus();
    tab(false, '[data-inside]');
    expect(document.activeElement).toBe(element('[data-after]'));
    expect(focused).not.toHaveBeenCalled();
  });

  it('returns programmatic focus to the outside control without scrolling', () => {
    render();
    const before = element('[data-before]');
    before.focus();
    const focus = vi.spyOn(before, 'focus');
    element('[data-inside]').focus();
    expect(document.activeElement).toBe(before);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focused).not.toHaveBeenCalled();
  });

  it('does not scan transcript descendants when choosing an outside focus target', () => {
    render();
    element('[data-before]').focus();
    const read = vi.fn();
    Object.defineProperty(element('[data-inside]'), 'getClientRects', { value: read });
    tab(false, '[data-flowchat-opening-guard="before"]');
    expect(read).not.toHaveBeenCalled();
  });

  it('blocks activation and native scroll gestures only inside the opening region', () => {
    render();
    element('[data-inside]').click();
    expect(action).not.toHaveBeenCalled();
    for (const type of ['wheel', 'touchmove', 'contextmenu', 'pointerdown', 'selectstart']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      element('[data-inside]').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const outside = new Event(type, { bubbles: true, cancelable: true });
      element('[data-after]').dispatchEvent(outside);
      expect(outside.defaultPrevented).toBe(false);
    }
  });

  it('releases focus, activation and scroll protection after reveal', () => {
    render();
    const guards = [...host.querySelectorAll<HTMLElement>('[data-flowchat-opening-guard]')];
    element('[data-after]').focus();
    render(false);
    expect(document.activeElement).toBe(element('[data-after]'));
    element('[data-inside]').focus();
    element('[data-inside]').click();
    expect(focused).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    const event = new Event('wheel', { bubbles: true, cancelable: true });
    element('[data-inside]').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect([...host.querySelectorAll('[data-flowchat-opening-guard]')]).toEqual(guards);
    for (const guard of guards) {
      expect(guard.tabIndex).toBe(-1);
      guard.focus();
      expect(document.activeElement).toBe(guard);
    }
    expect(element('[data-transcript]').hasAttribute('aria-hidden')).toBe(false);
  });

  it('blocks React-owned portal activation and focus while opening', () => {
    act(() => root.render(<>
      <button data-before>Before</button>
      <FlowChatOpeningBoundary opening>
        <Portal><button data-portal onClick={action} onFocus={focused}>Portal action</button></Portal>
      </FlowChatOpeningBoundary>
    </>));
    const before = element('[data-before]');
    before.focus();
    const portal = document.querySelector<HTMLButtonElement>('[data-portal]')!;
    portal.click();
    portal.focus();
    expect(action).not.toHaveBeenCalled();
    expect(focused).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
  });

  it('does not retain autofocus inside the initial commit', () => {
    act(() => root.render(<FlowChatOpeningBoundary opening>
      <input data-inside autoFocus onFocus={focused} />
    </FlowChatOpeningBoundary>));
    expect(document.activeElement).not.toBe(element('[data-inside]'));
    expect(focused).not.toHaveBeenCalled();
  });

  it('cleans up native interception on unmount', () => {
    render();
    const inside = element('[data-inside]');
    act(() => root.render(null));
    const event = new Event('wheel', { bubbles: true, cancelable: true });
    inside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
