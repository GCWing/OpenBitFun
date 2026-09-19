// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Field, Select, type SelectProps } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('public Select product integration', () => {
  let host: HTMLDivElement;
  let root: Root;
  const change = vi.fn();
  const options = [
    { label: 'Ask', value: 'ask', group: 'Built in' },
    { label: 'Plan', value: 'plan', disabled: true, group: 'Built in' },
    { label: 'Agent', value: 3, group: 'Advanced' },
  ];
  const render = (props: Partial<SelectProps> = {}) => act(() => root.render(
    <Select
      aria-label="Mode"
      defaultValue="ask"
      onValueChange={change}
      options={options}
      {...props}
    />,
  ));
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-openbitfun-part="trigger"]')!;
  const activeCombobox = () => document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
  const key = (element: Element, value: string) => act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value }));
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    change.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('opens a grouped portalled listbox with a selected row and check indicator', () => {
    render();
    const anchor = trigger();
    const comboboxId = anchor.id;
    act(() => anchor.click());

    const popup = document.querySelector<HTMLElement>('[data-openbitfun-component="select-popup"]')!;
    const header = popup.querySelector<HTMLButtonElement>('[data-openbitfun-part="header"]')!;
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const selected = listbox.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!;
    const layer = popup.closest('[data-openbitfun-overlay-layer]');
    expect(layer).not.toBeNull();
    expect(layer?.parentElement).toBe(document.querySelector('[data-openbitfun-overlay-host="true"]'));
    expect(layer?.parentElement?.parentElement).toBe(document.body);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(popup.contains(header)).toBe(true);
    expect(popup.contains(listbox)).toBe(true);
    expect(popup.children[0]).toBe(header);
    expect(popup.children[1]?.getAttribute('data-openbitfun-part')).toBe('divider');
    expect(popup.children[2]?.getAttribute('data-openbitfun-part')).toBe('options');
    expect(listbox.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(selected.textContent).toContain('Ask');
    expect(selected.querySelector('[data-openbitfun-part="indicator"]')).not.toBeNull();
    expect(anchor.getAttribute('aria-hidden')).toBe('true');
    expect(anchor.getAttribute('role')).toBeNull();
    expect(anchor.id).toBe('');
    expect(header.id).toBe(comboboxId);
    expect(activeCombobox()).toBe(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('button[role="combobox"]')).toHaveLength(1);
  });

  it('skips disabled options, commits typed values, closes, and restores focus', () => {
    render();
    const anchor = trigger();
    key(anchor, 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('Ask');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('Agent');
    key(document.activeElement!, 'Enter');

    expect(change).toHaveBeenLastCalledWith(3);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(anchor.textContent).toContain('Agent');
  });

  it.each(['sm', 'md', 'lg'] as const)('preserves the %s anchor contents and size while its popup is open', (size) => {
    render({ size });
    const anchor = trigger();
    const field = anchor.parentElement!;
    const content = [...anchor.childNodes];

    act(() => anchor.click());
    const popup = document.querySelector<HTMLElement>('[data-openbitfun-component="select-popup"]')!;
    expect(field.dataset.size).toBe(size);
    expect(popup.dataset.size).toBe(size);
    expect([...anchor.childNodes]).toEqual(content);
    expect(anchor.getAttribute('aria-hidden')).toBe('true');
    expect(anchor.tabIndex).toBe(-1);

    key(document.activeElement!, 'Escape');
    expect(document.querySelector('[data-openbitfun-component="select-popup"]')).toBeNull();
    expect([...anchor.childNodes]).toEqual(content);
    expect(field.dataset.size).toBe(size);
    expect(document.activeElement).toBe(anchor);
  });

  it('keeps controlled values authoritative while reporting the requested option', () => {
    render({ value: 'ask' });
    const anchor = trigger();
    act(() => anchor.click());
    const agent = document.querySelector<HTMLButtonElement>('[role="option"][data-value="3"]')!;
    act(() => agent.click());

    expect(change).toHaveBeenLastCalledWith(3);
    expect(anchor.textContent).toContain('Ask');
  });

  it('keeps the native form control synchronized for existing product integrations', () => {
    render();
    const native = host.querySelector<HTMLSelectElement>('select')!;
    expect(native.getAttribute('aria-hidden')).toBe('true');
    expect(native.value).toBe('ask');

    act(() => {
      native.value = '3';
      native.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(change).toHaveBeenLastCalledWith(3);
    expect(trigger().textContent).toContain('Agent');
  });

  it('moves Field semantics to a unified popup that exactly covers the anchor rectangle', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.openbitfunComponent === 'select-popup') return new DOMRect(0, 0, 240, 180);
      return new DOMRect(40, 20, 240, 32);
    });
    act(() => root.render(
      <Field description="Choose a mode" label="Mode" required>
        <Select options={options} />
      </Field>,
    ));
    const button = trigger();
    const comboboxId = button.id;
    expect(host.querySelector('label')?.htmlFor).toBe(button.id);
    expect(button.getAttribute('aria-required')).toBe('true');
    expect(button.getAttribute('aria-describedby')).not.toBeNull();

    act(() => button.click());
    const popup = document.querySelector<HTMLElement>('[data-openbitfun-component="select-popup"]')!;
    const header = popup.querySelector<HTMLButtonElement>('[data-openbitfun-part="header"]')!;
    expect(popup.style.left).toBe('40px');
    expect(popup.style.top).toBe('20px');
    expect(popup.style.width).toBe('240px');
    expect(popup.dataset.placement).toBe('bottom');
    expect(header.id).toBe(comboboxId);
    expect(host.querySelector('label')?.htmlFor).toBe(header.id);
    expect(header.getAttribute('aria-required')).toBe('true');
    expect(header.getAttribute('aria-describedby')).not.toBeNull();
  });
});
