/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { OverviewMiniAppLogos } from './OverviewMiniAppLogos';

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, currentLanguage: 'en-US', formatNumber: String }),
}));

let root: Root;
let container: HTMLDivElement;
let width: number;
const resizeListeners = new Set<() => void>();
const details = vi.fn();
const launch = vi.fn();
const viewAll = vi.fn();
const apps = Array.from({ length: 5 }, (_, index) => ({ id: `app-${index}`, name: `App ${index}`, icon: 'box' })) as MiniAppMeta[];
const visibleIds = () => [...container.querySelectorAll<HTMLElement>('[data-miniapp-id]')].map(element => element.dataset.miniappId);
const resize = (nextWidth: number) => act(() => { width = nextWidth; resizeListeners.forEach(listener => listener()); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  width = 136;
  vi.clearAllMocks();
  resizeListeners.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private listener: () => void) { resizeListeners.add(listener); }
    observe() {}
    disconnect() { resizeListeners.delete(this.listener); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return this.classList.contains('overview-miniapp-logos') ? width + 4 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return this.classList.contains('overview-miniapp-logos__probe') ? 40 : 0;
  });
  const originalStyle = window.getComputedStyle;
  vi.stubGlobal('getComputedStyle', (element: Element) => element.classList.contains('overview-miniapp-logos')
    ? { columnGap: '8px', paddingInlineStart: '2px', paddingInlineEnd: '2px' }
    : originalStyle(element));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () => act(async () => { root.render(<OverviewMiniAppLogos apps={apps} onDetails={details} onLaunch={launch} onViewAll={viewAll} />); });

it('fits complete logos to the measured width and reserves an overflow entry', async () => {
  await render();
  expect(visibleIds()).toEqual(['app-0', 'app-1']);
  expect(container.querySelector('[data-testid="personal-overview-more-miniapps"]')).not.toBeNull();
  resize(232);
  expect(visibleIds()).toEqual(apps.map(app => app.id));
  expect(container.querySelector('[data-testid="personal-overview-more-miniapps"]')).toBeNull();
  resize(88);
  expect(visibleIds()).toEqual(['app-0']);
  resize(0);
  expect(visibleIds()).toEqual(['app-0']);
  resize(40);
  expect(visibleIds()).toEqual([]);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-more-miniapps"]')!.click());
  expect(viewAll).toHaveBeenCalledOnce();
});

it('keeps details and launch independent and restores focus when a focused app is collapsed', async () => {
  await render();
  const first = container.querySelector<HTMLButtonElement>('[data-miniapp-id="app-0"]')!;
  await act(async () => first.click());
  expect(details).toHaveBeenCalledWith(apps[0]);
  expect(launch).not.toHaveBeenCalled();
  const card = first.closest('[data-openbitfun-component="action-card"]')!;
  await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="miniApps.start"]')!.click());
  expect(launch).toHaveBeenCalledWith('app-0');
  expect(details).toHaveBeenCalledOnce();
  container.querySelector<HTMLButtonElement>('[data-miniapp-id="app-1"]')!.focus();
  resize(88);
  expect(document.activeElement).toBe(container.querySelector('[data-testid="personal-overview-more-miniapps"]'));
});
