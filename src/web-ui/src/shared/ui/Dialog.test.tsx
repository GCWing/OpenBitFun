// @vitest-environment jsdom

import React, { act, useState } from 'react';
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
        <Surface open={open} onOpenChange={() => undefined} onExitComplete={onExitComplete}
          size={selected === 'Second' ? 'lg' : selected ? 'sm' : 'md'}>
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
    expect(surface.dataset.size).toBe('sm');
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('aria-describedby')).toBe(descriptionId);
    expect(surface.textContent).toContain('Edited description');
    expect(surface.textContent).not.toContain('No selection');
    expect(surface.querySelector('input')).toBe(input);
    expect(input?.value).toBe('Edited');
    act(() => vi.advanceTimersByTime(90));
    render(true, 'Second');
    expect(surface.dataset.size).toBe('lg');
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(input?.value).toBe('Second');
    act(() => vi.advanceTimersByTime(180));
    expect(surface.isConnected).toBe(true);
    expect(onExitComplete).not.toHaveBeenCalled();
    render(false, null);
    expect(surface.dataset.size).toBe('lg');
    act(() => vi.advanceTimersByTime(179));
    expect(surface.isConnected).toBe(true);
    expect(input?.value).toBe('Second');
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
    expect(onExitComplete).toHaveBeenCalledTimes(1);
    render(false, null);
    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps the model dialog geometry when an outside click clears its selection', () => {
    const reasons: string[] = [];
    function ModelEditor() {
      const [model, setModel] = useState<string | null>('Current model');
      return (
        <Dialog open={model !== null} size={model ? 'lg' : 'xl'}
          className={model ? 'model-editor' : 'provider-editor'}
          style={{ blockSize: model ? '640px' : '720px' }}
          overlayProps={{ className: model ? 'model-overlay' : 'provider-overlay' }}
          onOpenChange={(_, reason) => { reasons.push(reason); setModel(null); }}>
          <DialogHeader><DialogHeading><DialogTitle>{model ?? 'Provider'}</DialogTitle></DialogHeading></DialogHeader>
          <DialogBody>{model}</DialogBody>
        </Dialog>
      );
    }
    act(() => root.render(<ModelEditor />));
    const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const overlay = surface.parentElement!;
    act(() => overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(reasons).toEqual(['pointer-outside']);
    expect(surface.dataset.state).toBe('exiting');
    expect(surface.dataset.size).toBe('lg');
    expect(surface.classList.contains('model-editor')).toBe(true);
    expect(surface.style.blockSize).toBe('640px');
    expect(overlay.classList.contains('model-overlay')).toBe(true);
    expect(surface.textContent).not.toContain('Provider');
    act(() => vi.advanceTimersByTime(179));
    expect(surface.isConnected).toBe(true);
    expect(surface.dataset.size).toBe('lg');
    act(() => vi.advanceTimersByTime(1));
    expect(surface.isConnected).toBe(false);
  });
});
