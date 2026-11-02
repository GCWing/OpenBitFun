/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DesktopCardChangedPayload,
  DesktopCardRecord,
  DesktopCardStatePayload,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import { OverviewDesktopCardsSection } from './OverviewDesktopCardsSection';

const mocks = vi.hoisted(() => ({
  tauri: true,
  list: vi.fn(),
  setVisible: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  notifyError: vi.fn(),
  openDestination: vi.fn(),
  openScene: vi.fn(),
  changed: [] as Array<(payload: DesktopCardChangedPayload) => void>,
  state: [] as Array<(payload: DesktopCardStatePayload) => void>,
}));

vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => mocks.tauri }));
vi.mock('@/infrastructure/api/service-api/DesktopCardAPI', () => ({
  desktopCardAPI: {
    list: mocks.list,
    setVisible: mocks.setVisible,
    delete: mocks.remove,
    onChanged: (listener: (payload: DesktopCardChangedPayload) => void) => {
      mocks.changed.push(listener);
      return () => { mocks.changed = mocks.changed.filter(entry => entry !== listener); };
    },
    onStateChanged: (listener: (payload: DesktopCardStatePayload) => void) => {
      mocks.state.push(listener);
      return () => { mocks.state = mocks.state.filter(entry => entry !== listener); };
    },
  },
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: mocks.confirm }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.notifyError }) }));
vi.mock('@/app/scenes/settings/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ openDestination: mocks.openDestination }) },
}));
vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: { getState: () => ({ openScene: mocks.openScene }) },
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => options ? `${key}:${JSON.stringify(options)}` : key,
    formatNumber: String,
  }),
}));

let root: Root;
let container: HTMLDivElement;

const card = (id: string, extra: Partial<DesktopCardRecord> = {}): DesktopCardRecord => ({
  id,
  title: `Card ${id}`,
  template: { kind: 'note', text: 'hello' },
  visible: true,
  alwaysOnTop: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...extra,
} as DesktopCardRecord);

const render = (isActive = true) => act(async () => {
  root.render(<OverviewDesktopCardsSection isActive={isActive} />);
});
const rows = () => [...container.querySelectorAll<HTMLLIElement>('.overview-desktop-cards__item')];
const button = (row: Element, label: string) => row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.tauri = true;
  mocks.changed = [];
  mocks.state = [];
  mocks.list.mockReset();
  mocks.setVisible.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.notifyError.mockReset();
  mocks.openDestination.mockReset();
  mocks.openScene.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('lists cards newest first and reports how many are on the desktop', async () => {
  mocks.list.mockResolvedValue({ enabled: true, cards: [
    card('old', { updatedAtMs: 1 }),
    card('new', { updatedAtMs: 5, visible: false, subtitle: 'PR #42' }),
  ] });
  await render();
  expect(container.querySelector('[data-testid="personal-overview-desktop-card-count"]')?.textContent).toBe('2');
  expect(container.textContent).toContain('desktopCards.visibleCount:{"count":"1"}');
  expect(rows().map(row => row.textContent)).toEqual([
    expect.stringContaining('Card new'),
    expect.stringContaining('Card old'),
  ]);
  expect(rows()[0].textContent).toContain('desktopCards.hidden · PR #42');
  expect(rows()[0].dataset.visible).toBe('false');
});

it('shows, hides and deletes a card through the desktop host and follows host events', async () => {
  mocks.list.mockResolvedValue({ enabled: true, cards: [card('a'), card('b', { visible: false })] });
  await render();
  const [a, b] = rows();
  await act(async () => button(a, 'desktopCards.hide').click());
  expect(mocks.setVisible).toHaveBeenCalledWith('a', false);
  await act(async () => button(b, 'desktopCards.show').click());
  expect(mocks.setVisible).toHaveBeenCalledWith('b', true);

  await act(async () => mocks.changed.forEach(listener => listener({ cardId: 'a', card: card('a', { visible: false, updatedAtMs: 9 }), deleted: false })));
  expect(rows()[0].dataset.visible).toBe('false');

  await act(async () => button(rows()[0], 'desktopCards.delete').click());
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenCalledWith('a');
  await act(async () => mocks.changed.forEach(listener => listener({ cardId: 'a', card: null, deleted: true })));
  expect(rows()).toHaveLength(1);
});

it('keeps a card when deletion is not confirmed and reports host failures', async () => {
  mocks.list.mockResolvedValue({ enabled: true, cards: [card('a')] });
  mocks.confirm.mockResolvedValue(false);
  await render();
  await act(async () => button(rows()[0], 'desktopCards.delete').click());
  expect(mocks.remove).not.toHaveBeenCalled();

  mocks.setVisible.mockRejectedValue(new Error('host unavailable'));
  await act(async () => button(rows()[0], 'desktopCards.hide').click());
  expect(mocks.notifyError).toHaveBeenCalledWith('desktopCards.actionFailed');
});

it('keeps cards listed but blocks showing hidden ones while the feature is turned off', async () => {
  mocks.list.mockResolvedValue({ enabled: false, cards: [card('a', { visible: false })] });
  await render();
  expect(container.textContent).toContain('desktopCards.disabled');
  expect(button(rows()[0], 'desktopCards.show').disabled).toBe(true);
  await act(async () => mocks.state.forEach(listener => listener({ enabled: true })));
  expect(button(rows()[0], 'desktopCards.show').disabled).toBe(false);
});

it('offers retry after a failed read and opens the desktop card settings section', async () => {
  mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ enabled: true, cards: [] });
  await render();
  expect(container.textContent).toContain('desktopCards.failed');
  await act(async () => {
    [...container.querySelectorAll('button')].find(entry => entry.textContent === 'retry')!.click();
  });
  expect(container.textContent).toContain('desktopCards.empty');

  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-desktop-card-settings"]')!.click());
  expect(mocks.openDestination).toHaveBeenCalledWith({ pageId: 'application.pet', sectionId: 'desktop-cards' });
  expect(mocks.openScene).toHaveBeenCalledWith('settings');
});

it('renders nothing outside the desktop host and does not read while inactive', async () => {
  mocks.tauri = false;
  await render();
  expect(container.innerHTML).toBe('');
  mocks.tauri = true;
  mocks.list.mockResolvedValue({ enabled: true, cards: [] });
  await render(false);
  expect(mocks.list).not.toHaveBeenCalled();
});
