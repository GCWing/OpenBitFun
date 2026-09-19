// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Combobox,
  MultiSelect,
  Field,
  type ComboboxProps,
  type MultiSelectProps,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';

describe('public Combobox product integration', () => {
  let root: Root;
  let host: HTMLDivElement;
  const change = vi.fn();
  const options = [{ value: 'a', label: 'Alpha', group: 'First' }, { value: 'b', label: 'Beta', disabled: true }, { value: 'c', label: 'Gamma', group: 'First' }];
  const render = (props: ComboboxProps = {}) => act(() => root.render(<Combobox label="Models" options={options} onValueChange={change} {...props} />));
  const renderMultiSelect = (props: MultiSelectProps = {}) => act(() => root.render(<MultiSelect label="Models" options={options} onValueChange={change} {...props} />));
  const trigger = () => host.querySelector<HTMLButtonElement>('button[data-openbitfun-part="trigger"]')!;
  const key = (element: Element, value: string, composing = false) => act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing: composing, bubbles: true })); });
  const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = (value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); change.mockClear(); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it('navigates grouped options in DOM order and skips disabled entries', () => {
    render(); key(trigger(), 'ArrowDown'); key(input(), 'ArrowDown'); key(input(), 'Enter');
    expect(change).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(trigger());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('does not accept an IME confirmation as an option selection', () => {
    render({ onCreateValue: value => value }); act(() => trigger().click()); type('custom'); key(input(), 'Enter', true);
    expect(change).not.toHaveBeenCalled();
    key(input(), 'Enter'); expect(change).toHaveBeenLastCalledWith('custom');
  });
  it.each(['sm', 'md', 'lg'] as const)('keeps one active %s combobox and preserves Field semantics in the search header', (size) => {
    act(() => root.render(
      <Field label="Default terminal" description="Choose a shell" error="Required" required>
        <Combobox size={size} options={options} defaultValue="a" />
      </Field>,
    ));
    const anchor = trigger();
    const fieldId = anchor.id;
    const contents = [...anchor.childNodes];
    const describedBy = anchor.getAttribute('aria-describedby');
    act(() => anchor.click());

    const popup = document.querySelector<HTMLElement>('[data-openbitfun-component="combobox-popup"]')!;
    const search = input();
    const layer = popup.closest('[data-openbitfun-overlay-layer]');
    expect(layer).not.toBeNull();
    expect(layer?.parentElement).toBe(document.querySelector('[data-openbitfun-overlay-host="true"]'));
    expect(layer?.parentElement?.parentElement).toBe(document.body);
    expect(popup.children[0]?.getAttribute('data-openbitfun-part')).toBe('search');
    expect(popup.children[1]?.getAttribute('data-openbitfun-part')).toBe('divider');
    expect(popup.children[2]?.getAttribute('data-openbitfun-part')).toBe('options');
    expect(popup.dataset.size).toBe(size);
    expect(popup.querySelector('[data-openbitfun-component="search-field"]')?.getAttribute('data-variant')).toBe('embedded');
    expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(search.id).toBe(fieldId);
    expect(host.querySelector('label')?.htmlFor).toBe(search.id);
    expect(search.getAttribute('aria-describedby')).toBe(describedBy);
    expect(search.getAttribute('aria-required')).toBe('true');
    expect(search.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(search);
    expect([...anchor.childNodes]).toEqual(contents);
    expect(anchor.id).toBe('');
    expect(anchor.tabIndex).toBe(-1);

    act(() => popup.querySelector<HTMLButtonElement>('[data-openbitfun-part="collapse"]')!.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(anchor.id).toBe(fieldId);
    expect([...anchor.childNodes]).toEqual(contents);
  });

  it('clears only the search query and leaves multi-value tags mounted outside the popup', () => {
    renderMultiSelect({ defaultValue: ['a', 'c'], clearable: true, size: 'sm' });
    const anchor = trigger();
    const control = anchor.parentElement!;
    const tags = control.querySelector('[data-openbitfun-part="tags"]');
    act(() => anchor.click());
    type('gam');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(control.getAttribute('aria-hidden')).toBe('true');
    expect(control.querySelector('[data-openbitfun-part="tags"]')).toBe(tags);
    expect([...control.querySelectorAll('button')].every(button => button.tabIndex === -1)).toBe(true);
    const popup = document.querySelector('[data-openbitfun-component="multi-select-popup"]')!;
    const clear = popup.querySelector<HTMLButtonElement>('button[aria-label="Clear selection"]')!;
    act(() => clear.click());
    expect(input().value).toBe('');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(change).not.toHaveBeenCalled();
    key(input(), 'Escape');
    expect(document.activeElement).toBe(anchor);
    expect(control.querySelector('[data-openbitfun-part="tags"]')).toBe(tags);
  });

  it.each([false, true])('restores the native tab starting position before leaving the popup (shift=%s)', (shiftKey) => {
    render();
    const anchor = trigger();
    act(() => anchor.click());
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    act(() => {
      input().dispatchEvent(tab);
      expect(document.activeElement).toBe(anchor);
    });
    expect(tab.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('does not open a disabled picker even when its controlled open prop is true', () => {
    render({ disabled: true, open: true });
    expect(trigger().disabled).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('keeps controlled values authoritative and preserves numeric zero', () => {
    render({ value: 0, options: [{ value: 0, label: 'Zero' }, { value: 1, label: 'One' }] });
    act(() => trigger().click()); key(input(), 'ArrowDown'); key(input(), 'ArrowDown'); key(input(), 'Enter');
    expect(change).toHaveBeenLastCalledWith(1); expect(trigger().textContent).toContain('Zero');
  });
  it('supports multi-selection, select-all, custom values and async option hydration', () => {
    renderMultiSelect({ defaultValue: ['custom'], options: [], loading: true, showSelectAll: true });
    act(() => trigger().click()); expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading');
    renderMultiSelect({ defaultValue: ['custom'], options: [{ value: 'a', label: 'Alpha' }], showSelectAll: true });
    const all = [...document.querySelectorAll('button')].find(button => button.textContent === 'Select all')!;
    act(() => all.click()); expect(change).toHaveBeenLastCalledWith(['custom', 'a']);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
  it('closes only the picker on Escape inside a modal and restores trigger focus', () => {
    const close = vi.fn();
    act(() => root.render(<Dialog
      open
      onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}
      size="md"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{"Provider"}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody inset="none"><Combobox label="Models" />      </DialogBody>
    </Dialog>));
    const button = document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    act(() => button.click()); key(input(), 'Escape');
    expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button);
  });
  it('commits a typed custom single value on Tab and releases the popup', () => {
    render({ onCreateValue: value => value }); act(() => trigger().click()); type('custom'); key(input(), 'Tab');
    expect(change).toHaveBeenLastCalledWith('custom'); expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('removes individual selected tags without nesting buttons or opening the popup', () => {
    renderMultiSelect({ defaultValue: ['a', 'c'] });
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Clear selection: Alpha"]')!;
    expect(remove.closest('button[role="combobox"]')).toBeNull();
    act(() => remove.click());
    expect(change).toHaveBeenLastCalledWith(['c']);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('connects the public Field label, description, required and error states to the trigger', () => {
    act(() => root.render(<Field label="Models" description="Choose a model" error="Required" required><Combobox /></Field>));
    expect(host.querySelector('label')?.htmlFor).toBe(trigger().id);
    expect(trigger().getAttribute('aria-label')).toBeNull();
    expect(trigger().getAttribute('aria-required')).toBe('true');
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    const describedBy = trigger().getAttribute('aria-describedby')!.split(' ');
    expect(describedBy.map(id => document.getElementById(id)?.textContent)).toEqual(['Choose a model', 'Required']);
  });
  it('filters an initially open picker inside its portal', () => {
    render({ defaultOpen: true });
    type('gam');
    expect(input().value).toBe('gam');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.querySelector('[role="option"]')?.textContent).toBe('Gamma');
    expect(document.activeElement).toBe(input());
  });
  it('flips at the bottom edge and repositions after ancestor scrolling', () => {
    let top = window.innerHeight - 48;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.openbitfunComponent === 'combobox-popup') return new DOMRect(0, 0, 240, 180);
      return new DOMRect(40, top, 240, 40);
    });
    render(); act(() => trigger().click());
    const popup = document.querySelector<HTMLElement>('[data-openbitfun-component="combobox-popup"]')!;
    expect(popup.dataset.placement).toBe('top');
    top = 20;
    act(() => host.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(popup.dataset.placement).toBe('bottom');
    expect(popup.style.top).toBe('20px');
    expect(popup.style.width).toBe('240px');
  });
  it('reports controlled open requests without mutating controlled state', () => {
    const onOpenChange = vi.fn();
    render({ open: false, onOpenChange });
    act(() => trigger().click());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    render({ open: true, onOpenChange });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
});
