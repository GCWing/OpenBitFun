// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, ConfirmDialog, Dialog, MenuPopover, captureConfirmationAnchor } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('confirmation at the action origin', () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;
  const surface = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const key = async (value: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))); };

  beforeEach(() => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    trigger = document.createElement('button'); trigger.textContent = 'Origin'; document.body.append(trigger);
    trigger.focus();
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(240, 180, 48, 32));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); trigger.remove(); vi.restoreAllMocks();
  });

  it('places a compact confirmation next to its trigger and focuses Cancel', () => {
    act(() => root.render(<ConfirmDialog open anchor={captureConfirmationAnchor(trigger)} title="Delete record?"
      message="This cannot be undone." cancelText="Cancel" confirmText="Delete" onConfirm={vi.fn()} onOpenChange={vi.fn()} />));
    expect(surface().dataset.presentation).toBe('anchored');
    expect(surface().getAttribute('aria-modal')).toBe('false');
    expect(surface().style.left).toBe('240px');
    expect(surface().style.top).toBe('216px');
    expect(document.activeElement).toBe(button('Cancel'));
    expect(document.querySelector('[data-openbitfun-overlay-modal="true"]')).toBeNull();
  });

  it('keeps the captured menu-item position after the original element unmounts', () => {
    const anchor = captureConfirmationAnchor(trigger);
    trigger.remove();
    act(() => root.render(<ConfirmDialog open anchor={anchor} title="Delete?" onConfirm={vi.fn()} onOpenChange={vi.fn()} />));
    expect(surface().style.left).toBe('240px');
    expect(surface().style.top).toBe('216px');
  });

  it('flips and clamps at the window edge without moving to the screen center', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.getAttribute('role') === 'alertdialog' ? new DOMRect(0, 0, 320, 160) : new DOMRect();
    });
    vi.mocked(trigger.getBoundingClientRect).mockReturnValue(new DOMRect(940, 560, 40, 32));
    act(() => root.render(<ConfirmDialog open anchor={captureConfirmationAnchor(trigger)} title="Delete?" onConfirm={vi.fn()} onOpenChange={vi.fn()} />));
    expect(surface().dataset.placement).toBe('top');
    expect(surface().style.left).toBe('672px');
    expect(surface().style.top).toBe('396px');
  });

  it('keeps programmatic and high-impact confirmations modal without an origin', () => {
    act(() => root.render(<ConfirmDialog open title="Reset workspace?" onConfirm={vi.fn()} onOpenChange={vi.fn()} />));
    expect(surface().dataset.presentation).toBe('modal');
    expect(surface().getAttribute('aria-modal')).toBe('true');
  });

  it('owns only the child confirmation inside an existing modal and returns focus', async () => {
    const parentClosed = vi.fn();
    function Nested() {
      const [anchor, setAnchor] = useState<ReturnType<typeof captureConfirmationAnchor>>();
      return <><Dialog open onOpenChange={parentClosed} aria-label="Settings">
        <Button onClick={event => setAnchor(captureConfirmationAnchor(event.currentTarget))}>Remove service</Button>
      </Dialog>
        {anchor && <ConfirmDialog open anchor={anchor} title="Delete service?" cancelText="Cancel" confirmText="Delete"
          onConfirm={vi.fn()} onOpenChange={() => setAnchor(undefined)} />}</>;
    }
    act(() => root.render(<Nested />));
    await click('Remove service');
    expect(document.activeElement).toBe(button('Cancel'));
    expect(document.querySelectorAll('[data-openbitfun-overlay-modal="true"]')).toHaveLength(1);
    await key('Escape');
    expect(parentClosed).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button('Remove service'));
  });

  it('prevents repeated confirmation and dismissal while an async action is pending', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onClose = vi.fn();
    act(() => root.render(<ConfirmDialog open anchor={captureConfirmationAnchor(trigger)} title="Delete?" cancelText="Cancel" confirmText="Delete"
      onConfirm={onConfirm} onOpenChange={onClose} />));
    act(() => { button('Delete').click(); button('Delete').click(); });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(button('Delete').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    await key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(button('Delete').disabled).toBe(false);
  });

  it('confirms in the menu row, cancels with Escape, and forgets closed confirmations', async () => {
    const deleted = vi.fn();
    function Menu() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <><Button ref={anchor} onClick={() => setOpen(value => !value)}>More</Button>
        <MenuPopover open={open} anchorRef={anchor} onClose={() => setOpen(false)} items={[
          { id: 'open', label: 'Open' },
          { id: 'delete', label: 'Delete card', tone: 'danger', onSelect: deleted,
            confirmation: { description: 'Delete this card permanently?', cancelText: 'Cancel', confirmText: 'Confirm' } },
        ]} /></>;
    }
    act(() => root.render(<Menu />));
    await click('More'); await click('Delete card');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Open', 'Cancel', 'Confirm']);
    expect(document.activeElement).toBe(button('Cancel'));
    await key('ArrowRight'); expect(document.activeElement).toBe(button('Confirm'));
    await key('Escape'); expect(document.activeElement).toBe(button('Delete card'));
    expect(deleted).not.toHaveBeenCalled();
    await click('Delete card'); await key('Tab');
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-hidden')).toBe('true');
    await click('More');
    expect(document.querySelector('[data-openbitfun-menu-confirmation]')).toBeNull();
    await click('Delete card'); await click('More'); await click('More');
    expect(document.querySelector('[data-openbitfun-menu-confirmation]')).toBeNull();
    await click('Delete card'); await click('Confirm');
    expect(deleted).toHaveBeenCalledOnce();
  });

  it('keeps an in-flight menu action disabled after reopening and preserves the new opening', async () => {
    let finish!: () => void;
    const deleted = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    function Menu() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <><Button ref={anchor} onClick={() => setOpen(value => !value)}>More</Button>
        <MenuPopover open={open} anchorRef={anchor} onClose={() => setOpen(false)} exitDurationMs={0} items={[
          { id: 'delete', label: 'Delete card', onSelect: deleted,
            confirmation: { description: 'Delete this card?', cancelText: 'Cancel', confirmText: 'Confirm' } },
        ]} /></>;
    }
    act(() => root.render(<Menu />));
    await click('More'); await click('Delete card'); await click('Confirm');
    expect(deleted).toHaveBeenCalledOnce();
    await click('More'); await click('More');
    expect(button('Delete card').disabled).toBe(true);
    await click('Delete card');
    expect(deleted).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-hidden')).toBeNull();
    expect(button('Delete card').disabled).toBe(false);
  });
});
