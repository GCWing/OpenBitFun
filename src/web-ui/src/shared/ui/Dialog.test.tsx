// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogBody, DialogDescription, DialogHeader, DialogHeading, DialogTitle, Sheet } from '@openbitfun/ui';

describe('overlay exit content', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: false });
    vi.stubGlobal('matchMedia', () => media);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('supports an explicit portal host and leaves focus unchanged when restoration is disabled', () => {
    const host = document.createElement('div');
    const before = document.createElement('button');
    const after = document.createElement('button');
    document.body.append(host, before, after);
    before.focus();
    const close = vi.fn();
    act(() => root.render(<Dialog open onOpenChange={close} portalTarget={host}
      autoFocus={false} restoreFocus={false} trapFocus={false} preventScroll={false}
      closeOnEscape={false} closeOnPointerOutside={false}
      overlayProps={{ className: 'custom-scrim', 'data-product-overlay': 'preview' }}>
      <button>Inside</button>
    </Dialog>));
    expect(document.activeElement).toBe(before);
    expect(host.querySelector('.custom-scrim')?.getAttribute('data-openbitfun-part')).toBe('overlay');
    expect(host.querySelector('[data-product-overlay="preview"]')).not.toBeNull();
    after.focus();
    act(() => root.render(null));
    expect(document.activeElement).toBe(after);
    expect(host.childElementCount).toBe(0);
    host.remove(); before.remove(); after.remove();
  });

  it.each([Dialog, Sheet])('preserves committed content until exit, then accepts a fresh selection', (Surface) => {
    const onExitComplete = vi.fn();
    function render(open: boolean, selected: string | null) {
      act(() => root.render(
        <Surface open={open} onOpenChange={() => undefined} onExitComplete={onExitComplete}>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{selected ?? 'No selection'}</DialogTitle>
              {selected && <DialogDescription>{selected} description</DialogDescription>}
            </DialogHeading>
          </DialogHeader>
          <DialogBody>{selected && <input aria-label="Draft" value={selected} readOnly />}</DialogBody>
        </Surface>,
      ));
    }
    render(false, null);
    expect(onExitComplete).not.toHaveBeenCalled();
    render(true, 'First');
    const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = surface.querySelector('input');
    const descriptionId = surface.getAttribute('aria-describedby');
    render(true, 'Edited');
    render(false, null);
    expect(surface.dataset.state).toBe('exiting');
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('aria-describedby')).toBe(descriptionId);
    expect(surface.textContent).toContain('Edited description');
    expect(surface.textContent).not.toContain('No selection');
    expect(surface.querySelector('input')).toBe(input);
    expect(input?.value).toBe('Edited');
    act(() => vi.advanceTimersByTime(90));
    render(true, 'Second');
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(input?.value).toBe('Second');
    act(() => vi.advanceTimersByTime(180));
    expect(surface.isConnected).toBe(true);
    expect(onExitComplete).not.toHaveBeenCalled();
    render(false, null);
    act(() => vi.advanceTimersByTime(179));
    expect(surface.isConnected).toBe(true);
    expect(input?.value).toBe('Second');
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
    expect(onExitComplete).toHaveBeenCalledTimes(1);
    render(false, null);
    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });
});
