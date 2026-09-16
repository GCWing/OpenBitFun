// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NumberInput } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let input: HTMLInputElement;
const changed = vi.fn();
beforeEach(() => {
  changed.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<NumberInput value={180} min={0} max={180} onValueChange={changed} />));
  input = container.querySelector('input')!;
  act(() => input.focus());
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function key(value: string) {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
}
it('does not notify on unchanged blur or numerically equivalent input', () => {
  act(() => input.blur());
  act(() => input.focus());
  type('180.0');
  act(() => input.blur());
  expect(changed).not.toHaveBeenCalled();
});
it('commits changed input once on blur', () => {
  type('60');
  act(() => input.blur());
  expect(changed).toHaveBeenCalledExactlyOnceWith(60);
});
it('commits Enter exactly once even before the parent updates its value', () => {
  type('60');
  key('Enter');
  expect(changed).toHaveBeenCalledExactlyOnceWith(60);
});
it('discards Escape without committing the stale draft on blur', () => {
  type('60');
  key('Escape');
  expect(changed).not.toHaveBeenCalled();
  expect(input.value).toBe('180');
});
it('does not notify when clamping or stepping leaves the value unchanged', () => {
  key('ArrowUp');
  act(() => input.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })));
  type('999');
  act(() => input.blur());
  expect(changed).not.toHaveBeenCalled();
  expect(input.value).toBe('180');
});
it('preserves arrow-key changes and invalid-input recovery', () => {
  key('ArrowDown');
  expect(changed).toHaveBeenCalledExactlyOnceWith(179);
  changed.mockClear();
  type('invalid');
  act(() => input.blur());
  expect(changed).not.toHaveBeenCalled();
  expect(input.value).toBe('180');
});
