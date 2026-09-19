// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider, Dialog, OverlayLayer, OverlayRegion, Portal, MenuPopover, subscribeOverlayInteraction } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const slot = (id: string) => document.querySelector(`[data-test-layer="${id}"]`)!.closest<HTMLElement>('[data-openbitfun-overlay-layer]')!;
const rank = (id: string) => Number(slot(id).style.zIndex);

describe('document overlay ownership', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: false });
    vi.stubGlobal('matchMedia', () => media);
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(element => element.remove());
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it('orders independent cards and menus by opening, regardless of JSX/provider order', () => {
    const render = (first: boolean, second: boolean, progress = 0) => act(() => root.render(<React.StrictMode>
      <DesignSystemProvider>
        {first && <Portal><div data-test-layer="first">{progress}</div></Portal>}
        <DesignSystemProvider>{second && <Portal><div data-test-layer="second" /></Portal>}</DesignSystemProvider>
      </DesignSystemProvider>
    </React.StrictMode>));
    render(false, true); render(true, true);
    expect(rank('first')).toBeGreaterThan(rank('second'));
    const first = slot('first'); const before = rank('first');
    render(true, true, 90);
    expect(slot('first')).toBe(first); expect(rank('first')).toBe(before);
    render(true, false); render(true, true);
    expect(rank('second')).toBeGreaterThan(rank('first'));
  });

  it('gives each notification a rank without promoting older siblings', () => {
    const render = (menu: boolean, notice: boolean) => act(() => root.render(<>
      <OverlayRegion><div style={{ position: 'absolute' }}>
        <OverlayLayer passive><div data-test-layer="old" /></OverlayLayer>
        {notice && <OverlayLayer passive><div data-test-layer="new" /></OverlayLayer>}
      </div></OverlayRegion>
      {menu && <Portal><div data-test-layer="menu" /></Portal>}
    </>));
    render(false, false); render(true, false); render(true, true);
    expect(rank('old')).toBeLessThan(rank('menu'));
    expect(rank('new')).toBeGreaterThan(rank('menu'));
  });

  it('defers a background notice through modal exit and preserves an existing notice', () => {
    const render = (modal: boolean, notice: boolean) => act(() => root.render(<>
      <Portal passive><div data-test-layer="old" /></Portal>
      <Dialog open={modal} onOpenChange={() => undefined}><button data-test-layer="dialog">Confirm</button></Dialog>
      {notice && <Portal passive><div data-test-layer="queued" /></Portal>}
    </>));
    render(false, false); render(true, false); render(true, true);
    expect(document.querySelector('[data-test-layer="queued"]')).toBeNull();
    expect(slot('old').hasAttribute('inert')).toBe(true);
    expect(container.hasAttribute('inert')).toBe(true);
    render(false, true);
    expect(document.querySelector('[data-test-layer="queued"]')).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('[data-test-layer="queued"]')).not.toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(slot('old').hasAttribute('inert')).toBe(false);
  });

  it('keeps portalled menu focus inside its modal domain and dismisses only the menu', () => {
    const dismissDialog = vi.fn();
    function Content() {
      const trigger = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <Dialog open onOpenChange={dismissDialog}>
        <button ref={trigger} onClick={() => setOpen(true)}>Open menu</button>
        <MenuPopover open={open} onClose={() => setOpen(false)} anchorRef={trigger} items={[{ id: 'one', label: 'Option' }]} />
      </Dialog>;
    }
    act(() => root.render(<Content />));
    const trigger = document.querySelector('[role="dialog"] button') as HTMLButtonElement;
    act(() => trigger.click());
    expect(document.activeElement?.textContent).toBe('Option');
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(dismissDialog).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('routes custom interactions only to the latest surface', () => {
    const first = vi.fn(), second = vi.fn();
    function Surface({ id, onKey }: { id: string; onKey: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      React.useEffect(() => subscribeOverlayInteraction(ref, 'keydown', onKey), [onKey]);
      return <Portal><div ref={ref} data-test-layer={id} /></Portal>;
    }
    act(() => root.render(<><Surface id="first" onKey={first} /><Surface id="second" onKey={second} /></>));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
  });

  it('restores modal focus after exit without stealing from a newer dialog', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const render = (first: boolean, second = false) => act(() => root.render(<>
      <Dialog open={first} onOpenChange={() => undefined}><button data-test-layer="first-dialog">First</button></Dialog>
      <Dialog open={second} onOpenChange={() => undefined}><button data-test-layer="second-dialog">Second</button></Dialog>
    </>));
    render(true);
    render(false, true);
    const secondButton = document.querySelector('[data-test-layer="second-dialog"]');
    expect(document.activeElement).toBe(secondButton);
    act(() => vi.advanceTimersByTime(180));
    expect(document.activeElement).toBe(secondButton);
    expect(document.body.style.overflow).toBe('hidden');
    render(false, false);
    act(() => vi.advanceTimersByTime(180));
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
    trigger.remove();
  });

  it('restores focus when the only modal finishes exiting', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const render = (open: boolean) => act(() => root.render(
      <Dialog open={open} onOpenChange={() => undefined}><button>Inside</button></Dialog>,
    ));
    render(true);
    expect(document.activeElement?.textContent).toBe('Inside');
    render(false);
    expect(trigger.hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(180));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it.each([true, false])('defers a notice requested in the same commit as a modal (notice first: %s)', (first) => {
    const notice = <Portal passive key="notice"><div data-test-layer="notice" /></Portal>;
    const dialog = <Dialog key="modal" open onOpenChange={() => undefined}><button>Confirm</button></Dialog>;
    act(() => root.render(first ? [notice, dialog] : [dialog, notice]));
    expect(document.querySelector('[data-test-layer="notice"]')).toBeNull();
  });

  it('owns sibling child portals through their trigger and hides them with the parent', () => {
    function Content({ open }: { open: boolean }) {
      const trigger = useRef<HTMLButtonElement>(null);
      return <>
        <Dialog open={open} onOpenChange={() => undefined}>
          <button ref={trigger}>Trigger</button>
        </Dialog>
        <Portal ownerRef={trigger}><button data-test-layer="child">Option</button></Portal>
      </>;
    }
    act(() => root.render(<Content open />));
    const child = document.querySelector<HTMLButtonElement>('[data-test-layer="child"]')!;
    child.focus();
    expect(document.activeElement).toBe(child);
    act(() => root.render(<Content open={false} />));
    expect(slot('child').hidden).toBe(true);
  });

  it('lets a focused card handle Escape without dismissing an older menu', () => {
    const closeMenu = vi.fn(), closeCard = vi.fn();
    function Content() {
      const menu = useRef<HTMLDivElement>(null);
      return <>
        <Portal surfaceRef={menu} onDismiss={closeMenu}><div ref={menu}>Menu</div></Portal>
        <Portal passive><button onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); closeCard(); }
        }}>Card</button></Portal>
      </>;
    }
    act(() => root.render(<Content />));
    const card = document.querySelector('button')!;
    card.focus();
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closeCard).toHaveBeenCalledOnce();
    expect(closeMenu).not.toHaveBeenCalled();
  });

  it('does not cascade outside dismissal across pointerdown and mousedown', () => {
    const closeFirst = vi.fn();
    function Content() {
      const [open, setOpen] = useState(true);
      const first = useRef<HTMLDivElement>(null), second = useRef<HTMLDivElement>(null);
      React.useEffect(() => subscribeOverlayInteraction(first, 'mousedown', closeFirst), []);
      return <>
        <Portal><div ref={first}>First</div></Portal>
        {open && <Portal surfaceRef={second} dismissOnPointerOutside onDismiss={() => setOpen(false)}><div ref={second}>Second</div></Portal>}
      </>;
    }
    act(() => root.render(<Content />));
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(closeFirst).not.toHaveBeenCalled();
  });

  it('keeps modal barriers and Escape ownership in their own document', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const frameDocument = frame.contentDocument!;
    const closeLocal = vi.fn(), closeFrame = vi.fn();
    function Content() {
      const local = useRef<HTMLDivElement>(null), remote = useRef<HTMLDivElement>(null);
      return <>
        <Portal surfaceRef={local} onDismiss={closeLocal}><div ref={local}>Local</div></Portal>
        <Portal ownerDocument={frameDocument} modal surfaceRef={remote} onDismiss={closeFrame}>
          <div ref={remote} tabIndex={-1}><button>Frame</button></div>
        </Portal>
      </>;
    }
    act(() => root.render(<Content />));
    expect(container.hasAttribute('inert')).toBe(false);
    act(() => frameDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closeFrame).toHaveBeenCalledOnce();
    expect(closeLocal).not.toHaveBeenCalled();
    act(() => root.render(null));
    frame.remove();
  });

  it('does not let a custom parent Escape listener bypass its child dismissal', () => {
    const parentKey = vi.fn(), childDismiss = vi.fn();
    function Content() {
      const parent = useRef<HTMLDivElement>(null), child = useRef<HTMLDivElement>(null);
      React.useEffect(() => subscribeOverlayInteraction(parent, 'keydown', parentKey), []);
      return <Portal><div ref={parent}>
        <Portal surfaceRef={child} onDismiss={childDismiss}><div ref={child}>Child menu</div></Portal>
      </div></Portal>;
    }
    act(() => root.render(<Content />));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(childDismiss).toHaveBeenCalledOnce();
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('protects an older focused card when a later menu owns Escape', () => {
    const closeCard = vi.fn(), closeMenu = vi.fn();
    function Content({ menu }: { menu: boolean }) {
      const surface = useRef<HTMLDivElement>(null);
      return <>
        <Portal passive><button data-test-layer="card" onKeyDown={closeCard}>Card</button></Portal>
        {menu && <Portal surfaceRef={surface} onDismiss={closeMenu}><div ref={surface}>Menu</div></Portal>}
      </>;
    }
    act(() => root.render(<Content menu={false} />));
    const button = document.querySelector<HTMLButtonElement>('[data-test-layer="card"]')!;
    button.focus();
    act(() => root.render(<Content menu />));
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(closeCard).not.toHaveBeenCalled();
  });

  it('releases focus and scroll ownership when a sibling modal loses its parent', () => {
    function Content({ parent }: { parent: boolean }) {
      const trigger = useRef<HTMLButtonElement>(null), child = useRef<HTMLDivElement>(null);
      return <>
        {parent && <Portal><button ref={trigger}>Parent</button></Portal>}
        <Portal modal ownerRef={trigger} surfaceRef={child}>
          <div ref={child} data-test-layer="owned-modal" tabIndex={-1}><button>Child</button></div>
        </Portal>
      </>;
    }
    act(() => root.render(<Content parent />));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.render(<Content parent={false} />));
    expect(slot('owned-modal').hidden).toBe(true);
    expect(document.body.style.overflow).toBe('');
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('shares the coordinator across separately loaded package instances', async () => {
    act(() => root.render(<Portal><button>Open surface</button></Portal>));
    vi.resetModules();
    const reloadedEntry = await import('@openbitfun/ui');
    expect(reloadedEntry.hasOverlayLayers(document)).toBe(true);
    act(() => root.render(null));
    expect(reloadedEntry.hasOverlayLayers(document)).toBe(false);
  });
});
