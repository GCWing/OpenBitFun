import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DesktopCardWindow from './DesktopCardWindow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  isMac: false,
  isWindows: true,
  setDesktopPinned: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  nativeWindow: true,
  card: null as unknown,
  startResize: vi.fn(async (_direction: string) => {}),
  startDrag: vi.fn(async () => {}),
}));

vi.mock('./DesktopCardWindow.scss', () => ({}));

vi.mock('./DesktopCardTemplates', () => {
  const Template = ({ template }: { template: { kind: string; text?: string } }) => (
    <div data-template={template.kind}>{template.text}</div>
  );
  return {
    ChecklistTemplate: Template,
    CountdownTemplate: Template,
    CronJobTemplate: Template,
    CustomTemplate: Template,
    MetricsTemplate: Template,
    NoteTemplate: Template,
    ProgressTemplate: Template,
  };
});

vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
  Icon: () => <span />,
  IconButton: React.forwardRef<HTMLButtonElement, { 'aria-label'?: string; onClick?: () => void }>(
    ({ 'aria-label': label, onClick }, ref) => <button ref={ref} aria-label={label} onClick={onClick} />,
  ),
  MenuPopover: ({ items, open }: { items: Array<{ id: string; label: string; checked?: boolean; disabled?: boolean; onSelect?: () => void }>; open: boolean }) => open ? (
    <div role="menu">{items.filter(item => item.onSelect).map(item => (
      <button key={item.id} data-menu-id={item.id} aria-checked={item.checked} disabled={item.disabled} onClick={item.onSelect}>{item.label}</button>
    ))}</div>
  ) : null,
  OverflowText: ({ children, ...props }: { children: React.ReactNode }) => <span {...props}>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { error?: string }) => values?.error ? `${key}: ${values.error}` : key,
    formatNumber: (value: number) => String(value),
    formatDate: (value: number) => String(value),
    formatRelativeTime: () => 'just now',
  }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/infrastructure/api/service-api/DesktopCardAPI', () => ({
  // Mirrors the host rule: desktop pinning and global always-on-top are exclusive.
  isDesktopPinned: (card: { desktopPinned?: boolean; alwaysOnTop?: boolean }) =>
    card.desktopPinned === true && !card.alwaysOnTop,
  desktopCardAPI: {
    get: vi.fn(async () => mocks.card),
    onChanged: vi.fn(() => () => {}),
    setChecklistItem: vi.fn(),
    setVisible: vi.fn(async () => mocks.card),
    delete: vi.fn(async () => {}),
    refresh: vi.fn(async () => mocks.card),
    setAlwaysOnTop: mocks.setAlwaysOnTop,
    setDesktopPinned: mocks.setDesktopPinned,
  },
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: { openExternal: vi.fn(async () => {}) },
}));

vi.mock('@/infrastructure/desktop-cards/desktopCardWindow', () => ({
  DESKTOP_CARD_RESIZE_DIRECTIONS: ['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'],
  readDesktopCardIdFromLocation: () => 'card-1',
  openDesktopCardSourceSession: vi.fn(async () => {}),
  startDesktopCardWindowDrag: mocks.startDrag,
  startDesktopCardWindowResize: mocks.startResize,
}));

vi.mock('@/infrastructure/runtime/environment', () => ({
  supportsNativeWindowControls: () => mocks.nativeWindow,
  isMacOSDesktopRuntime: () => mocks.isMac,
  isWindowsDesktopRuntime: () => mocks.isWindows,
}));

function noteCard(lastData?: Record<string, unknown>) {
  return {
    id: 'card-1',
    title: 'Repo stats',
    template: { kind: 'note', text: 'hello' },
    ...(lastData
      ? { dataSource: { kind: 'command', command: 'gh api', intervalSeconds: 300 }, lastData }
      : {}),
    visible: true,
    alwaysOnTop: true,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe('DesktopCardWindow', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    mocks.isMac = false;
    mocks.nativeWindow = true;
    mocks.card = noteCard();
    mocks.isWindows = true;
    mocks.setDesktopPinned.mockReset().mockImplementation(async (_id: string, pinned: boolean) => ({ ...noteCard(), alwaysOnTop: false, desktopPinned: pinned }));
    mocks.setAlwaysOnTop.mockReset().mockImplementation(async (_id: string, top: boolean) => ({ ...noteCard(), alwaysOnTop: top, desktopPinned: false }));
    mocks.startResize.mockClear();
    mocks.startDrag.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(<DesktopCardWindow />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function click(selector: string) {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(selector)!.click();
      await Promise.resolve();
    });
  }

  it('switches between desktop pinning and global topmost without hiding the card', async () => {
    mocks.card = { ...noteCard(), desktopPinningSupported: true };
    await render();
    await click('[aria-label="desktopCard.menu.more"]');
    await click('[data-menu-id="desktop-pinned"]');
    expect(mocks.setDesktopPinned).toHaveBeenCalledWith('card-1', true);
    expect(container.querySelector('[data-menu-id="desktop-pinned"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-menu-id="always-on-top"]')?.getAttribute('aria-checked')).toBe('false');
    await click('[data-menu-id="always-on-top"]');
    expect(mocks.setAlwaysOnTop).toHaveBeenCalledWith('card-1', true);
    expect(container.querySelector('[data-menu-id="desktop-pinned"]')?.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('hello');
  });

  it.each([false, undefined])('hides desktop pinning when the host does not advertise it (%s)', async supported => {
    mocks.card = { ...noteCard(), desktopPinningSupported: supported };
    await render();
    await click('[aria-label="desktopCard.menu.more"]');
    expect(container.querySelector('[data-menu-id="desktop-pinned"]')).toBeNull();
  });

  it('hides desktop pinning outside Windows even if the capability was advertised', async () => {
    mocks.isWindows = false;
    mocks.card = { ...noteCard(), desktopPinningSupported: true };
    await render();
    await click('[aria-label="desktopCard.menu.more"]');
    expect(container.querySelector('[data-menu-id="desktop-pinned"]')).toBeNull();
  });

  it('reports a rejected native mode change without changing the selected mode', async () => {
    mocks.card = { ...noteCard(), desktopPinningSupported: true };
    mocks.setDesktopPinned.mockRejectedValueOnce(new Error('Explorer unavailable'));
    await render();
    await click('[aria-label="desktopCard.menu.more"]');
    await click('[data-menu-id="desktop-pinned"]');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('desktopCard.stackingFailed: Explorer unavailable');
    expect(container.querySelector('[data-menu-id="always-on-top"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-menu-id="desktop-pinned"]')?.getAttribute('aria-checked')).toBe('false');
  });

  function regions() {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-openbitfun-part="resizeHandle"]'));
  }

  function mouseDown(target: Element, button = 0) {
    act(() => {
      target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));
    });
  }

  it('adds edge and corner resize regions on Windows and Linux', async () => {
    await render();
    expect(container.textContent).toContain('Repo stats');
    expect(regions().map(region => region.dataset.direction).sort()).toEqual(
      ['East', 'North', 'NorthEast', 'NorthWest', 'South', 'SouthEast', 'SouthWest', 'West'],
    );

    const corner = regions().find(region => region.dataset.direction === 'SouthEast')!;
    mouseDown(corner, 2);
    expect(mocks.startResize).not.toHaveBeenCalled();
    mouseDown(corner);
    expect(mocks.startResize).toHaveBeenCalledWith('SouthEast');

    const north = regions().find(region => region.dataset.direction === 'North')!;
    mouseDown(north);
    expect(mocks.startResize).toHaveBeenLastCalledWith('North');
    expect(mocks.startDrag).not.toHaveBeenCalled();
  });

  it('keeps native resizing on macOS and outside the desktop host', async () => {
    mocks.isMac = true;
    await render();
    expect(container.textContent).toContain('Repo stats');
    expect(regions()).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(container);
    mocks.isMac = false;
    mocks.nativeWindow = false;
    await render();
    expect(regions()).toHaveLength(0);
  });

  it('shows the loading state with resize regions before the card arrives', async () => {
    mocks.card = new Promise(() => {});
    await render();
    expect(container.querySelector('[data-openbitfun-state="loading"]')).not.toBeNull();
    expect(regions()).toHaveLength(8);
  });

  function footer() {
    return container.querySelector<HTMLElement>('[data-openbitfun-part="footer"]')!;
  }

  it('flags stderr output when it explains missing values', async () => {
    mocks.card = {
      ...noteCard({ fetchedAtMs: 1, value: { stars: null }, warning: 'gh: rate limited' }),
      template: { kind: 'metrics', items: [{ label: 'Stars', path: '/stars' }] },
    };
    await render();
    expect(footer().dataset.openbitfunState).toBe('warning');
    expect(footer().getAttribute('title')).toBe('gh: rate limited');
    expect(footer().textContent).toBe('desktopCard.updatedWithWarning');
  });

  it('keeps harmless stderr output in the tooltip only', async () => {
    mocks.card = noteCard({ fetchedAtMs: 1, value: { stars: 3 }, warning: 'Downloading...' });
    await render();
    expect(footer().dataset.openbitfunState).toBeUndefined();
    expect(footer().getAttribute('title')).toBe('Downloading...');
    expect(footer().textContent).toBe('desktopCard.updated');
  });
});
