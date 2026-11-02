// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsPageId } from './settingsTypes';
import { useSettingsScrollRestoration } from './useSettingsScrollRestoration';

function Page({ pageId, epoch, section = false, ready = true }: {
  pageId: SettingsPageId; epoch: number; section?: boolean; ready?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useSettingsScrollRestoration(root, pageId, epoch, ready, section ? 'hooks' : null, 0);
  return <div ref={root}><div key={pageId} className="openbitfun-config-page-layout"><div /></div></div>;
}

describe('settings scroll restoration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let epoch = 0;
  let resize: () => void;
  const viewport = () => container.querySelector<HTMLElement>('.openbitfun-config-page-layout')!;
  const render = (pageId: SettingsPageId, section = false, ready = true) => act(() => {
    root.render(<Page pageId={pageId} epoch={epoch} section={section} ready={ready} />);
  });
  beforeEach(() => {
    epoch += 1;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

  it('restores each page after loading and releases restoration as soon as the user scrolls', () => {
    render('application.general');
    viewport().dispatchEvent(new Event('wheel', { bubbles: true }));
    viewport().scrollTop = 240;
    viewport().dispatchEvent(new Event('scroll'));
    render('tools.automation');
    expect(viewport().scrollTop).toBe(0);
    render('application.general', false, false);
    expect(viewport().scrollTop).toBe(0);
    render('application.general');
    expect(viewport().scrollTop).toBe(240);
    viewport().scrollTop = 0;
    resize();
    expect(viewport().scrollTop).toBe(240);
    viewport().dispatchEvent(new Event('wheel', { bubbles: true }));
    viewport().scrollTop = 70;
    resize();
    expect(viewport().scrollTop).toBe(70);
  });

  it('lets section links own scrolling and clears positions when the device activation changes', () => {
    render('tools.automation');
    viewport().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    viewport().scrollTop = 240;
    viewport().dispatchEvent(new Event('scroll'));
    render('application.general');
    render('tools.automation', true);
    expect(viewport().scrollTop).toBe(0);
    viewport().scrollTop = 90;
    resize();
    expect(viewport().scrollTop).toBe(90);
    epoch += 1;
    render('tools.automation');
    expect(viewport().scrollTop).toBe(0);
  });
});
