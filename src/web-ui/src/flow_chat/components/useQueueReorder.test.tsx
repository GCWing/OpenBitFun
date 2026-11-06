/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useQueueReorder } from '@openbitfun/ui/flow-chat';
let root: Root;
let container: HTMLDivElement;
const move = vi.fn();
const captures = new WeakMap<HTMLElement, number>();
function Fixture({ revision = 1, enabled = true, ids = ['a', 'b', 'c'] }) {
  const reorder = useQueueReorder(ids, enabled, revision, move);
  return <ul>{ids.map(id => <li key={id} {...reorder.rowProps(id)}><button {...reorder.handleProps(id)}>{id}</button></li>)}</ul>;
}
function render(revision = 1, enabled = true) {
  act(() => root.render(<Fixture revision={revision} enabled={enabled} />));
  container.querySelector('ul')!.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120 }) as DOMRect;
  container.querySelectorAll('li').forEach((row, i) => {
    row.getBoundingClientRect = () => ({ top: i * 40, bottom: (i + 1) * 40, height: 40 }) as DOMRect;
  });
}
function pointer(type: string, y: number, target = container.querySelector('button')!, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  act(() => target.dispatchEvent(event));
}
beforeEach(() => {
  move.mockClear();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  HTMLElement.prototype.setPointerCapture = function(id) { captures.set(this, id); };
  HTMLElement.prototype.hasPointerCapture = function(id) { return captures.get(this) === id; };
  HTMLElement.prototype.releasePointerCapture = function() { captures.delete(this); };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  render();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('commits only once on release with the insertion target and ignores another pointer', () => {
  pointer('pointerdown', 20); pointer('pointermove', 85);
  expect(move).not.toHaveBeenCalled();
  expect(container.querySelector('li[data-queue-drop="before"]')?.textContent).toBe('c');
  pointer('pointerup', 85, container.querySelector('button')!, 2);
  expect(move).not.toHaveBeenCalled();
  pointer('pointerup', 85);
  expect(move).toHaveBeenCalledExactlyOnceWith('a', 'c');
  expect(container.querySelector('[data-queue-dragging]')).toBeNull();
});
it.each(['Escape', 'blur', 'pointercancel', 'lostpointercapture'])('cancels without a mutation on %s', event => {
  pointer('pointerdown', 20); pointer('pointermove', 110);
  if (event === 'Escape') act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  else if (event === 'blur') act(() => window.dispatchEvent(new Event('blur')));
  else pointer(event, 110);
  pointer('pointerup', 110);
  expect(move).not.toHaveBeenCalled();
});
it('host revision changes invalidate the entire gesture', () => {
  pointer('pointerdown', 20); pointer('pointermove', 110); render(2); pointer('pointerup', 110);
  expect(move).not.toHaveBeenCalled();
});
it('arrow keys expose reorder without dragging and unsupported hosts disable the handles', () => {
  act(() => container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(move).toHaveBeenCalledExactlyOnceWith('a', 'c');
  move.mockClear(); render(1, false);
  expect(container.querySelector('button')!.disabled).toBe(true);
  pointer('pointerdown', 20); pointer('pointermove', 110); pointer('pointerup', 110);
  expect(move).not.toHaveBeenCalled();
});

it('restores keyboard focus after a host mutation disables and then re-enables the grip', () => {
  const handle = container.querySelector('button')!;
  act(() => { handle.focus(); handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  render(1, false);
  act(() => handle.blur());
  render(2, true);
  expect(document.activeElement).toBe(handle);
});
