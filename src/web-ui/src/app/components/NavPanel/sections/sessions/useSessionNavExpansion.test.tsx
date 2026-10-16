// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionDisplayLimit } from './sessionNavExpand';
import { useSessionNavExpansion } from './useSessionNavExpansion';

describe('source-filter session expansion', () => {
  let container: HTMLDivElement;
  let root: Root;
  const renders: Array<{ scope: string; rows: number }> = [];

  function List({ scope, count }: { scope: string; count: number }) {
    const { expandLevel, level2DisplayCount, setExpandLevel, setLevel2DisplayCount } = useSessionNavExpansion(scope, 200);
    const rows = getSessionDisplayLimit({ loadedTopLevelCount: count, expandLevel, level2DisplayCount, showAllWithoutLimit: false });
    renders.push({ scope, rows });
    return <>
      <output>{rows}</output>
      <button data-action="more" onClick={() => setExpandLevel(1)}>More</button>
      <button data-action="all" onClick={() => setExpandLevel(2)}>All</button>
      <button data-action="next" onClick={() => setLevel2DisplayCount(previous => previous + 200)}>Next page</button>
      <button data-action="less" onClick={() => setExpandLevel(0)}>Less</button>
    </>;
  }

  const render = (scope: string, count: number) => act(() => { root.render(<List scope={scope} count={count} />); });
  const click = (action: string) => act(() => { container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click(); });
  const count = () => Number(container.querySelector('output')?.textContent);

  beforeEach(() => {
    renders.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts each agent filter with five rows, including the first render after an expanded view', () => {
    render('local:project:all', 350);
    expect(count()).toBe(5);
    click('all');
    expect(count()).toBe(200);
    render('local:project:codex', 300);
    expect(renders.filter(render => render.scope === 'local:project:codex').every(render => render.rows === 5)).toBe(true);
    expect(count()).toBe(5);
    click('more');
    expect(count()).toBe(10);
    render('local:project:zcode', 50);
    expect(count()).toBe(5);
    render('local:project:codex', 300);
    expect(count()).toBe(5);
    render('local:project:all', 350);
    expect(count()).toBe(5);
  });

  it('keeps newly loaded metadata folded and expands only through the list controls', () => {
    render('local:project:codex', 3);
    expect(count()).toBe(3);
    render('local:project:codex', 600);
    expect(count()).toBe(5);
    click('more');
    expect(count()).toBe(10);
    click('all');
    expect(count()).toBe(200);
    click('next');
    expect(count()).toBe(400);
    click('less');
    expect(count()).toBe(5);
    click('all');
    expect(count()).toBe(200);
    render('peer:project:codex', 600);
    expect(count()).toBe(5);
  });
});
