// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionDisplayLimit, nextSessionDisplayCount } from './sessionNavExpand';
import { useSessionNavExpansion } from './useSessionNavExpansion';

describe('session list expansion state', () => {
  let container: HTMLDivElement;
  let root: Root;
  const renders: Array<{ scope: string; rows: number }> = [];

  function List({ scope, count, visible = true }: { scope: string; count: number; visible?: boolean }) {
    const { displayCount, setDisplayCount } = useSessionNavExpansion(scope, { visible, shouldHandOff: () => visible });
    const rows = getSessionDisplayLimit({ loadedTopLevelCount: count, displayCount, showAllWithoutLimit: false });
    renders.push({ scope, rows });
    return <>
      <output>{rows}</output>
      <button data-action="toggle" onClick={() => setDisplayCount(nextSessionDisplayCount(displayCount, count))}>Toggle</button>
    </>;
  }

  const render = (scope: string, count: number) => act(() => { root.render(<List scope={scope} count={count} />); });
  const click = () => act(() => { container.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click(); });
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

  it('starts every view compact, including the first render after an expanded view', () => {
    render('local:project:all', 30);
    expect(count()).toBe(3);
    click();
    click();
    expect(count()).toBe(13);
    render('local:project:codex', 30);
    expect(renders.filter(entry => entry.scope === 'local:project:codex').every(entry => entry.rows === 3)).toBe(true);
  });

  it('adds five per click and collapses once everything is shown', () => {
    render('local:project:all', 12);
    click();
    expect(count()).toBe(8);
    click();
    expect(count()).toBe(12);
    click();
    expect(count()).toBe(3);
  });

  it('hands the count to the list that replaces it after a device switch', () => {
    render('peer:project:all', 30);
    click();
    act(() => root.unmount());
    root = createRoot(container);
    render('peer:project:all', 30);
    expect(count()).toBe(8);
    act(() => root.unmount());
    root = createRoot(container);
    render('peer:project:other', 30);
    expect(count()).toBe(3);
  });

  it('starts over at three rows when a collapsed workspace opens again', () => {
    render('local:project:all', 30);
    click();
    expect(count()).toBe(8);
    act(() => { root.render(<List scope="local:project:all" count={30} visible={false} />); });
    act(() => { root.render(<List scope="local:project:all" count={30} />); });
    expect(count()).toBe(3);
  });

  it('does not hand a collapsed list count to the next mount', () => {
    act(() => { root.render(<List scope="peer:project:all" count={30} />); });
    click();
    act(() => { root.render(<List scope="peer:project:all" count={30} visible={false} />); });
    act(() => root.unmount());
    root = createRoot(container);
    render('peer:project:all', 30);
    expect(count()).toBe(3);
  });
});
