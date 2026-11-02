// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LinkHandler = (event: MouseEvent, uri: string) => void;

const hoisted = vi.hoisted(() => ({
  linkHandlers: [] as Array<(event: MouseEvent, uri: string) => void>,
  openExternal: vi.fn(async () => {}),
}));

/** Any property is a no-op function returning a disposable-ish stub. */
function stub(): unknown {
  const fn = () => stub();
  return new Proxy(fn, {
    get: (_target, prop) => {
      if (prop === 'dispose') return () => {};
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'then') return undefined;
      if (prop === 'cols' || prop === 'rows' || prop === 'length') return 80;
      return stub();
    },
  });
}

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function MockXTerm() {
    return stub();
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function MockFit() { return stub(); }) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(function MockWebgl() { return stub(); }) }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function MockWebLinks(handler: LinkHandler) {
    hoisted.linkHandlers.push(handler);
    return stub();
  }),
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: { openExternal: hoisted.openExternal },
}));
vi.mock('@/infrastructure/appearance/adapters/XtermAppearanceAdapter', () => ({
  xtermAppearanceAdapter: {
    getColors: () => ({ background: '#000000', foreground: '#ffffff' }),
    subscribe: () => () => {},
    onChange: () => () => {},
  },
}));

import Terminal from './Terminal';

describe('Terminal link activation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    hoisted.linkHandlers.length = 0;
    hoisted.openExternal.mockClear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class NoopObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', NoopObserver);
    vi.stubGlobal('IntersectionObserver', NoopObserver);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function click(uri: string) {
    const handler = hoisted.linkHandlers.at(-1);
    expect(handler).toBeDefined();
    handler!(new MouseEvent('click', { ctrlKey: true }), uri);
  }

  it('routes Ctrl/Cmd+click through onLinkActivate when provided', () => {
    const onLinkActivate = vi.fn();
    act(() => root.render(<Terminal onLinkActivate={onLinkActivate} />));
    click('http://127.0.0.1:5173/');
    expect(onLinkActivate).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    expect(hoisted.openExternal).not.toHaveBeenCalled();
  });

  it('opens the link externally when no handler is provided', () => {
    act(() => root.render(<Terminal />));
    click('https://example.com/');
    expect(hoisted.openExternal).toHaveBeenCalledWith('https://example.com/');
  });
});
