// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import MessageSendingSettingsSection from './MessageSendingSettingsSection';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), error: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: () => false, getCachedConfig: () => undefined,
  getOptionalConfig: mocks.get, setConfig: mocks.set,
  watch: (_path: string, listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
} }));
vi.mock('@openbitfun/ui', async original => ({
  ...await original<typeof import('@openbitfun/ui')>(),
  Select: ({ value, disabled, options, onValueChange }: {
    value: string; disabled: boolean; options: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => <select value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));

describe('message sending settings persistence', () => {
  let root: Root;
  let container: HTMLDivElement;
  const select = () => container.querySelector('select')!;
  const choose = async (value: string) => act(async () => {
    select().value = value;
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    mocks.get.mockReset().mockResolvedValue(undefined);
    mocks.set.mockReset().mockImplementation(async (_path: string, value: string) => {
      mocks.get.mockResolvedValue(value);
      mocks.listeners.forEach(listener => listener());
    });
    mocks.error.mockReset();
    mocks.listeners.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); activateSurface('local'); });

  it('starts with immediate and persists both choices using only the preference leaf', async () => {
    await act(async () => root.render(<MessageSendingSettingsSection />));
    expect(select().value).toBe('immediate');
    await choose('queue');
    expect(mocks.set).toHaveBeenLastCalledWith('app.flow_chat.send_during_turn', 'queue');
    expect(select().value).toBe('queue');
    await choose('immediate');
    expect(mocks.set).toHaveBeenLastCalledWith('app.flow_chat.send_during_turn', 'immediate');
    expect(select().value).toBe('immediate');
    expect(select().disabled).toBe(false);
  });

  it('retains the saved behavior when persistence fails', async () => {
    mocks.set.mockRejectedValue(new Error('Write failed'));
    await act(async () => root.render(<MessageSendingSettingsSection />));
    await choose('queue');
    expect(select().value).toBe('immediate');
    expect(mocks.error).toHaveBeenCalledWith('messageSending.saveFailed');
    expect(select().disabled).toBe(false);
  });

  it('keeps the picker unavailable after a failed read and allows recovery', async () => {
    mocks.get.mockRejectedValue(new Error('Host unavailable'));
    await act(async () => root.render(<MessageSendingSettingsSection />));
    expect(select()).toBeNull();
    expect(container.textContent).toContain('messageSending.loadFailed');
    mocks.get.mockResolvedValue('queue');
    await act(async () => container.querySelector('button')!.click());
    expect(select().value).toBe('queue');
  });
});
