// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColorPicker, type ColorPickerProps } from '@openbitfun/ui';

describe('ColorPicker interaction', () => {
  let host: HTMLDivElement;
  let root: Root;
  const changed = vi.fn();
  const part = <T extends HTMLElement = HTMLElement>(name: string) => host.querySelector<T>(`[data-openbitfun-part="${name}"]`)!;
  const input = () => host.querySelector<HTMLInputElement>('input')!;
  const key = (target: HTMLElement, value: string, shiftKey = false) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
  });
  function Example(props: Partial<ColorPickerProps>) {
    const [value, setValue] = useState('#3366CC');
    return <ColorPicker value={value} onValueChange={next => { changed(next); setValue(next); }} {...props} />;
  }
  const render = (props: Partial<ColorPickerProps> = {}) => act(() => root.render(<Example {...props} />));
  const pointer = (type: string, x: number, y: number, pointerId = 1) => act(() => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    part('lightness').dispatchEvent(event);
  });
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    changed.mockReset();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 336, height: 280 } as DOMRect);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  });

  it('opens without changing the color, chooses a petal, and closes with Escape', () => {
    render();
    expect(part('expansion').hidden).toBe(true);
    act(() => part('swatch').click());
    expect(part('expansion').hidden).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    const petal = part<HTMLButtonElement>('petal');
    act(() => petal.click());
    expect(input().value).toBe(petal.getAttribute('aria-label'));
    key(petal, 'Escape');
    expect(part('expansion').hidden).toBe(true);
    expect(document.activeElement).toBe(part('swatch'));
  });

  it('retains the last valid preview during incomplete HEX editing and commits shorthand', () => {
    render();
    act(() => { input().focus(); Simulate.change(input(), { target: { value: '#12' } } as React.ChangeEvent<HTMLInputElement>); });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(part('root').style.getPropertyValue('--_color-picker-value')).toBe('#3366CC');
    act(() => Simulate.change(input(), { target: { value: '#abc' } } as React.ChangeEvent<HTMLInputElement>));
    key(input(), 'Enter');
    expect(input().value).toBe('#AABBCC');
    expect(changed.mock.calls.filter(([value]) => value === '#AABBCC')).toHaveLength(1);
    expect(input().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('cancels an incomplete edit without committing shorthand on blur', () => {
    render({ defaultOpen: true });
    act(() => { input().focus(); Simulate.change(input(), { target: { value: '#abc' } } as React.ChangeEvent<HTMLInputElement>); });
    key(input(), 'Escape');
    expect(input().value).toBe('#3366CC');
    expect(part('expansion').hidden).toBe(false);
    key(part('swatch'), 'Escape');
    expect(part('expansion').hidden).toBe(true);
  });

  it('does not emit a color change for unchanged focus and blur', () => {
    render();
    act(() => { input().focus(); input().blur(); });
    expect(changed).not.toHaveBeenCalled();
    act(() => input().focus());
    key(input(), 'Escape');
    expect(changed).not.toHaveBeenCalled();
  });

  it('preserves the selected hue through black and white keyboard endpoints', () => {
    render({ defaultOpen: true });
    const slider = part('lightness');
    key(slider, 'Home'); expect(input().value).toBe('#000000');
    key(slider, 'End'); expect(input().value).toBe('#FFFFFF');
    key(slider, 'PageDown');
    const color = input().value;
    expect(color).not.toBe('#E6E6E6');
    expect(slider.getAttribute('aria-valuenow')).toBe('90');
    key(slider, 'ArrowDown', true);
    expect(slider.getAttribute('aria-valuenow')).toBe('80');
  });

  it('maps curved pointer positions, ignores other pointers, and stops on cancellation', () => {
    render({ defaultOpen: true });
    pointer('pointerdown', 284, 57);
    expect(input().value).toBe('#FFFFFF');
    pointer('pointermove', 284, 223, 2);
    expect(input().value).toBe('#FFFFFF');
    pointer('pointerdown', 284, 223, 2);
    pointer('pointercancel', 284, 223, 2);
    expect(input().value).toBe('#FFFFFF');
    pointer('pointermove', 284, 223);
    expect(input().value).toBe('#000000');
    pointer('pointercancel', 284, 223);
    changed.mockClear();
    pointer('pointermove', 306, 140);
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps controlled expansion with the owner and blocks disabled interaction', () => {
    const openChange = vi.fn();
    render({ open: false, onOpenChange: openChange });
    act(() => part('swatch').click());
    expect(openChange).toHaveBeenCalledWith(true);
    expect(part('expansion').hidden).toBe(true);
    render({ open: true, disabled: true });
    expect(part('expansion').hidden).toBe(true);
    expect(input().disabled).toBe(true);
    key(part('lightness'), 'End');
    pointer('pointerdown', 284, 57);
    expect(changed).not.toHaveBeenCalled();
  });

  it('supports independent uncontrolled values and localized labels', () => {
    act(() => root.render(<ColorPicker defaultValue="#123456" labels={{ color: 'Localized HEX', lightness: 'Localized lightness' }} defaultOpen />));
    expect(input().getAttribute('aria-label')).toBe('Localized HEX');
    expect(part('lightness').getAttribute('aria-label')).toBe('Localized lightness');
    key(part('lightness'), 'Home');
    expect(input().value).toBe('#000000');
  });
});
