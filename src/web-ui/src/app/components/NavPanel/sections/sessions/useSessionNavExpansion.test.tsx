// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionDisplayLimit, nextSessionDisplayCount } from './sessionNavExpand';
import { resetSessionNavExpansion, useSessionNavExpansion } from './useSessionNavExpansion';
import { surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { setWorkspaceSessionsCollapsed } from '../workspaces/workspaceDisclosure';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('session list expansion state', () => {
  let container: HTMLDivElement;
  let root: Root;
  const renders: Array<{ scope: string; rows: number }> = [];

  function List({ scope, count, visible = true }: { scope: string; count: number; visible?: boolean }) {
    const { displayCount, setDisplayCount } = useSessionNavExpansion(scope, { visible });
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
    resetSessionNavExpansion();
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

  it('keeps the count when live and background lists replace each other in the same commit', () => {
    const scope = 'same-commit:project:all';
    const replace = (key: string) => act(() => {
      root.render(<List key={key} scope={scope} count={12} />);
    });
    replace('live');
    click();
    expect(count()).toBe(8);
    renders.length = 0;
    replace('background');
    expect(renders.every(entry => entry.rows === 8)).toBe(true);
    expect(count()).toBe(8);
    click();
    click();
    expect(count()).toBe(3);
    renders.length = 0;
    replace('live-again');
    expect(renders.every(entry => entry.rows === 3)).toBe(true);
  });

  it('does not let StrictMode replay consume a previous expansion', () => {
    const scope = 'strict:project:all';
    act(() => root.render(<React.StrictMode><List key="live" scope={scope} count={12} /></React.StrictMode>));
    click();
    renders.length = 0;
    act(() => root.render(<React.StrictMode><List key="background" scope={scope} count={12} /></React.StrictMode>));
    expect(renders.every(entry => entry.rows === 8)).toBe(true);
  });

  it('starts over at three rows when a collapsed workspace opens again', () => {
    render('local:project:all', 30);
    click();
    expect(count()).toBe(8);
    act(() => { root.render(<List scope="local:project:all" count={30} visible={false} />); });
    act(() => { root.render(<List scope="local:project:all" count={30} />); });
    expect(count()).toBe(3);
  });

  it('collapses all source views of one workspace without resetting the same workspace on another device', () => {
    const local = `${surfaceScopedKey('local', 'shared')}:all`;
    const peer = `${surfaceScopedKey('peer', 'shared')}:all`;
    const source = `${surfaceScopedKey('peer', 'shared')}:codex`;
    for (const scope of [local, peer, source]) { render(scope, 12); click(); }
    act(() => setWorkspaceSessionsCollapsed('peer', 'shared', true));
    for (const scope of [peer, source]) { render(scope, 12); expect(count()).toBe(3); }
    render(local, 12);
    expect(count()).toBe(8);
    act(() => useWorkspaceSessionViewStore.getState().requestCollapseAll());
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
