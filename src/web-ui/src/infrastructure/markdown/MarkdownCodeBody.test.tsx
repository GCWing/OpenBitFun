// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownCodeBody } from './MarkdownCodeBody';

afterEach(() => { window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); });

describe('viewport-owned code decoration', () => {
  it('retains every source, recycles decoration, preserves selected nodes and releases observation', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let notify: IntersectionObserverCallback;
    const observed = new Set<Element>();
    const disconnect = vi.fn();
    const constructor = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { constructor(); notify = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect = disconnect;
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const emit = (elements: Element[], visible: boolean) => act(() => notify(elements.map(target => ({ target, isIntersecting: visible })) as IntersectionObserverEntry[], {} as IntersectionObserver));
    try {
      act(() => root.render(<>{Array.from({ length: 100 }, (_, index) => <MarkdownCodeBody key={index} deferHighlighting>
        {visible => <pre><code>{visible ? <span data-token="">{`const value = ${index};`}</span> : `const value = ${index};`}</code></pre>}
      </MarkdownCodeBody>)}</>));
      expect(constructor).toHaveBeenCalledTimes(1);
      expect(observed.size).toBe(100);
      expect(container.querySelectorAll('pre')).toHaveLength(100);
      expect(container.querySelectorAll('[data-token]')).toHaveLength(0);
      const bodies = [...observed];
      const completeText = container.textContent;
      emit(bodies.slice(0, 2), true);
      expect(container.querySelectorAll('[data-token]')).toHaveLength(2);
      expect(container.textContent).toBe(completeText);
      const selected = container.querySelector('[data-token]')!.firstChild!;
      const selection = window.getSelection()!, range = document.createRange();
      range.selectNodeContents(selected); selection.addRange(range);
      emit(bodies.slice(0, 2), false);
      expect(container.querySelectorAll('[data-token]')).toHaveLength(1);
      expect(selection.anchorNode).toBe(selected);
      expect(selection.toString()).toBe('const value = 0;');
      act(() => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
      expect(container.querySelectorAll('[data-token]')).toHaveLength(0);
      expect(container.textContent).toBe(completeText);
    } finally { act(() => root.unmount()); container.remove(); }
    expect(observed.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
