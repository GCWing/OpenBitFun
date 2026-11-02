/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectResourceList } from './ProjectResourceList';

let host: HTMLDivElement;
let root: Root;
let height: number;
let measure: (() => void) | undefined;
const open = vi.fn();
const add = vi.fn();
const items = Array.from({ length: 6 }, (_, index) => ({ id: String(index), name: `Item ${index}`, meta: 'Ready', onClick: open }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  height = 108;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(target: Element) { if (target.classList.contains('project-resource-list')) measure = this.callback; }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: 300, height: this.classList.contains('project-resource-list') ? height : 28 } as DOMRect;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const resize = (nextHeight: number) => act(() => { height = nextHeight; measure?.(); });
async function render(withAdd = false) {
  await act(async () => root.render(<ProjectResourceList items={items} label="Resources" moreLabel="All resources" onShowAll={open}
    addAction={withAdd ? { label: 'Add resource', onClick: add } : undefined} />));
  host.querySelector<HTMLUListElement>('ul')!.style.rowGap = '12px';
  resize(height);
}

it('reserves an overflow row, recalculates capacity on resize, and opens the full list', async () => {
  await render();
  expect(host.querySelectorAll('li')).toHaveLength(3);
  expect(host.querySelectorAll('.project-resource-list__name')).toHaveLength(2);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="All resources"]')!.click());
  expect(open).toHaveBeenCalledOnce();
  resize(148);
  expect(host.querySelectorAll('.project-resource-list__name')).toHaveLength(3);
  resize(228);
  expect(host.querySelectorAll('.project-resource-list__name')).toHaveLength(6);
  expect(host.querySelector('.project-resource-list__more')).toBeNull();
  resize(68);
  expect(host.querySelectorAll('li')).toHaveLength(2);
});

it('keeps the add item visible as resources overflow or the available height shrinks', async () => {
  await render(true);
  expect(host.querySelectorAll('li')).toHaveLength(3);
  expect(host.querySelectorAll('.project-resource-list__name')).toHaveLength(1);
  expect(host.querySelector('li:last-child')?.textContent).toBe('Add resource');
  resize(68);
  expect(host.querySelectorAll('li')).toHaveLength(2);
  expect(host.querySelector('.project-resource-list__more')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.project-resource-list__add')!.click());
  expect(add).toHaveBeenCalledOnce();
});
