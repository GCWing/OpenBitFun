// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DesktopCardChangedPayload,
  DesktopCardRecord,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import DesktopCardsSettingsSection from './DesktopCardsSettingsSection';

const mocks = vi.hoisted(() => ({
  tauri: true,
  cached: { enable_desktop_cards: true } as { enable_desktop_cards?: boolean } | undefined,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  list: vi.fn(),
  setDesktopPinned: vi.fn(),
  changed: [] as Array<(payload: DesktopCardChangedPayload) => void>,
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock('@openbitfun/ui', () => ({
  Switch: ({ checked, disabled, onChange, 'aria-label': label }: {
    checked: boolean;
    disabled?: boolean;
    onChange?: (event: { currentTarget: { checked: boolean } }) => void;
    'aria-label': string;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={event => onChange?.({ currentTarget: { checked: event.currentTarget.checked } })}
    />
  ),
}));

vi.mock('@/infrastructure/config/components/common', () => ({
  ConfigPageSection: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <section><h2>{title}</h2>{children}</section>
  ),
  ConfigPageRow: ({ label, description, children, ...rest }: {
    label: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-testid={rest['data-testid'] as string | undefined}>
      <span>{label}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
  ConfigLoadingState: () => <div>loading</div>,
  ConfigRetryState: () => <div>retry</div>,
}));

vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  aiExperienceConfigService: {
    getCachedSettings: () => mocks.cached,
    getSettingsAsync: mocks.getSettings,
    saveSettings: mocks.saveSettings,
    addChangeListener: () => () => {},
  },
}));

vi.mock('@/infrastructure/api/service-api/DesktopCardAPI', () => ({
  // Mirrors the host rule: desktop pinning and global always-on-top are exclusive.
  isDesktopPinned: (card: { desktopPinned?: boolean; alwaysOnTop?: boolean }) =>
    card.desktopPinned === true && !card.alwaysOnTop,
  desktopCardAPI: {
    list: mocks.list,
    setDesktopPinned: mocks.setDesktopPinned,
    onChanged: (listener: (payload: DesktopCardChangedPayload) => void) => {
      mocks.changed.push(listener);
      return () => { mocks.changed = mocks.changed.filter(entry => entry !== listener); };
    },
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { title?: string }) => values?.title ? `${key}:${values.title}` : key,
  }),
}));

vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => ({ isCurrent: () => true }),
}));

vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => mocks.tauri }));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ error: mocks.notifyError, success: mocks.notifySuccess }),
}));

vi.mock('../shared/useSettingsSectionAnchor', () => ({
  useSettingsSectionAnchor: (id: string) => id,
}));

const card = (id: string, extra: Partial<DesktopCardRecord> = {}): DesktopCardRecord => ({
  id,
  title: `Card ${id}`,
  template: { kind: 'note', text: 'hello' },
  visible: false,
  alwaysOnTop: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...extra,
} as DesktopCardRecord);

let root: Root;
let container: HTMLDivElement;

const render = () => act(async () => {
  root.render(<DesktopCardsSettingsSection />);
});
const pinRows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="desktop-card-pin-row"]')];
const pinSwitch = (row: Element) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.tauri = true;
  mocks.cached = { enable_desktop_cards: true };
  mocks.changed = [];
  mocks.getSettings.mockReset();
  mocks.saveSettings.mockReset();
  mocks.list.mockReset();
  mocks.setDesktopPinned.mockReset().mockResolvedValue(undefined);
  mocks.notifyError.mockReset();
  mocks.notifySuccess.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('offers a pin switch per card, including hidden ones, and pins them through the host', async () => {
  mocks.list.mockResolvedValue({
    enabled: true,
    desktopPinningSupported: true,
    cards: [
      card('a', { updatedAtMs: 2 }),
      card('b', { updatedAtMs: 1, alwaysOnTop: false, desktopPinned: true }),
    ],
  });
  await render();
  expect(pinRows()).toHaveLength(2);
  expect(pinSwitch(pinRows()[0]).checked).toBe(false);
  expect(pinSwitch(pinRows()[1]).checked).toBe(true);
  expect(pinRows()[1].textContent).toContain('features.desktopCards.pinnedOn');

  await act(async () => pinSwitch(pinRows()[0]).click());
  expect(mocks.setDesktopPinned).toHaveBeenCalledWith('a', true);
});

it('follows host change events so the switch reflects the applied mode', async () => {
  mocks.list.mockResolvedValue({
    enabled: true,
    desktopPinningSupported: true,
    cards: [card('a', { updatedAtMs: 2 })],
  });
  await render();
  await act(async () => mocks.changed.forEach(listener => listener({
    cardId: 'a',
    card: card('a', { updatedAtMs: 3, alwaysOnTop: false, desktopPinned: true }),
    deleted: false,
  })));
  expect(pinSwitch(pinRows()[0]).checked).toBe(true);
  expect(pinRows()[0].textContent).toContain('features.desktopCards.pinnedOn');
});

it('keeps the pin rows hidden when the host cannot pin', async () => {
  mocks.list.mockResolvedValue({ enabled: true, cards: [card('a')] });
  await render();
  expect(pinRows()).toHaveLength(0);
});

it('renders nothing to pin and never reads cards while the feature is off', async () => {
  mocks.cached = { enable_desktop_cards: false };
  mocks.list.mockResolvedValue({ enabled: false, desktopPinningSupported: true, cards: [card('a')] });
  await render();
  expect(pinRows()).toHaveLength(0);
  expect(mocks.list).not.toHaveBeenCalled();
});

it('reports a rejected pin change without flipping the switch', async () => {
  mocks.list.mockResolvedValue({
    enabled: true,
    desktopPinningSupported: true,
    cards: [card('a')],
  });
  mocks.setDesktopPinned.mockRejectedValue(new Error('Explorer unavailable'));
  await render();
  await act(async () => pinSwitch(pinRows()[0]).click());
  expect(mocks.notifyError).toHaveBeenCalledWith('features.desktopCards.pinFailed');
  expect(pinSwitch(pinRows()[0]).checked).toBe(false);
});
