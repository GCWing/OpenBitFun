// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkillsPageLayout } from './useSkillsPageLayout';

let root: Root;
let container: HTMLDivElement;
let viewportHeight: number;
let gridTop: number;
let rowHeight: number;
let columns: number;
const resizeCallbacks = new Set<() => void>();

function Harness({ total = 21, lastPage = false, enabled = true, hasMore = false }: {
  total?: number;
  lastPage?: boolean;
  enabled?: boolean;
  hasMore?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const layout = useSkillsPageLayout({ viewportRef, contentRef, gridRef, total, enabled, hasMore });
  return (
    <div ref={viewportRef} data-measure="viewport" data-rows={layout.rows} data-page-size={layout.pageSize}>
      <div ref={contentRef} data-measure="content">
        <div ref={gridRef} data-measure="grid">
          {Array.from({ length: lastPage ? 1 : Math.min(total, layout.pageSize) }, (_, index) => (
            <div key={index} data-measure="card">Skill {index + 1}</div>
          ))}
        </div>
        {(total > layout.pageSize || hasMore) && <nav className="skills-pagination">Pagination</nav>}
      </div>
    </div>
  );
}

const render = (props: React.ComponentProps<typeof Harness> = {}) => act(async () => {
  root.render(<Harness {...props} />);
});
const resize = () => act(async () => {
  for (const callback of [...resizeCallbacks]) callback();
});
const capacity = () => {
  const viewport = container.querySelector<HTMLElement>('[data-measure="viewport"]')!;
  return { rows: Number(viewport.dataset.rows), pageSize: Number(viewport.dataset.pageSize) };
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  viewportHeight = 600;
  gridTop = 160;
  rowHeight = 64;
  columns = 2;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resizeCallbacks.add(callback); }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.measure === 'viewport' ? viewportHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let top = 100;
    let height = 0;
    if (this.dataset.measure === 'grid') {
      top += gridTop - (this.closest('[data-measure="viewport"]')?.scrollTop ?? 0);
    }
    if (this.dataset.measure === 'card') height = rowHeight;
    if (this.classList.contains('skills-pagination')) height = 64;
    return { top, height, bottom: top + height, left: 0, right: 680, width: 680, x: 0, y: top, toJSON() {} };
  });
  const getStyle = getComputedStyle;
  vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {
    const style = element.dataset.measure || element.classList.contains('skills-pagination')
      ? document.createElement('div').style
      : getStyle(element);
    if (element.dataset.measure === 'grid') {
      style.gridTemplateColumns = columns === 2 ? '320px 320px' : '320px';
      style.rowGap = '16px';
    }
    if (element.dataset.measure === 'content') style.paddingBottom = '24px';
    if (element.classList.contains('skills-pagination')) style.marginTop = '16px';
    return style;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  expect(resizeCallbacks.size).toBe(0);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Installed skills viewport capacity', () => {
  it('accounts for page chrome and gaps, grows with the viewport, and caps at five rows', async () => {
    await render();
    expect(capacity()).toEqual({ rows: 4, pageSize: 8 });
    viewportHeight = 500;
    await resize();
    expect(capacity()).toEqual({ rows: 3, pageSize: 6 });
    viewportHeight = 1000;
    await resize();
    expect(capacity()).toEqual({ rows: 5, pageSize: 10 });
  });

  it('fits exact row boundaries and leaves at least one row in very short windows', async () => {
    viewportHeight = 648;
    await render();
    expect(capacity().rows).toBe(5);
    viewportHeight = 647;
    await resize();
    expect(capacity().rows).toBe(4);
    viewportHeight = 100;
    await resize();
    expect(capacity()).toEqual({ rows: 1, pageSize: 2 });
  });

  it('adapts to a single column and the taller wrapped toolbar in narrow windows', async () => {
    await render();
    columns = 1;
    gridTop = 200;
    await resize();
    expect(capacity()).toEqual({ rows: 3, pageSize: 3 });
    viewportHeight = 1000;
    await resize();
    expect(capacity()).toEqual({ rows: 5, pageSize: 5 });
  });

  it('keeps the same reserved rows on a short last page and after scrolling', async () => {
    await render();
    await render({ lastPage: true });
    container.querySelector<HTMLElement>('[data-measure="viewport"]')!.scrollTop = 120;
    await resize();
    expect(capacity()).toEqual({ rows: 4, pageSize: 8 });
  });

  it('handles the pager appearing and disappearing without oscillating capacity', async () => {
    await render({ total: 10 });
    expect(capacity()).toEqual({ rows: 5, pageSize: 10 });
    expect(container.querySelector('nav')).toBeNull();
    viewportHeight = 550;
    await resize();
    expect(capacity()).toEqual({ rows: 3, pageSize: 6 });
    expect(container.querySelector('nav')).not.toBeNull();
    viewportHeight = 600;
    await resize();
    await resize();
    expect(capacity()).toEqual({ rows: 5, pageSize: 10 });
    expect(container.querySelector('nav')).toBeNull();
  });

  it('remeasures taller text and ignores hidden scenes until they become measurable', async () => {
    viewportHeight = 0;
    await render({ enabled: false });
    expect(resizeCallbacks.size).toBe(0);
    await render();
    expect(capacity()).toEqual({ rows: 5, pageSize: 10 });
    viewportHeight = 600;
    rowHeight = 80;
    await resize();
    expect(capacity()).toEqual({ rows: 3, pageSize: 6 });
  });

  it('reserves pager space for a market that still has unloaded results', async () => {
    await render({ total: 4, hasMore: true });
    expect(capacity()).toEqual({ rows: 4, pageSize: 8 });
    expect(container.querySelector('nav')).not.toBeNull();
    await render({ total: 4 });
    expect(capacity()).toEqual({ rows: 5, pageSize: 10 });
    expect(container.querySelector('nav')).toBeNull();
  });
});
