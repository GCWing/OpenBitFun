import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DesktopCardWindow from './DesktopCardWindow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  isMac: false,
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
    ChartTemplate: Template,
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
  MenuPopover: () => null,
  OverflowText: ({ children, ...props }: { children: React.ReactNode }) => <span {...props}>{children}</span>,
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatNumber: (value: number) => String(value),
    formatDate: (value: number) => String(value),
    formatRelativeTime: () => 'just now',
  }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/infrastructure/api/service-api/DesktopCardAPI', () => ({
  desktopCardAPI: {
    get: vi.fn(async () => mocks.card),
    onChanged: vi.fn(() => () => {}),
    setChecklistItem: vi.fn(),
    setVisible: vi.fn(async () => mocks.card),
    delete: vi.fn(async () => {}),
    refresh: vi.fn(async () => mocks.card),
    setAlwaysOnTop: vi.fn(async () => mocks.card),
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
