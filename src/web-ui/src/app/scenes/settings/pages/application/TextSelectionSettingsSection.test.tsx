// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import TextSelectionSettingsSection from './TextSelectionSettingsSection';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), error: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  getOptionalConfig: mocks.get,
  setConfig: mocks.set,
  watch: (_path: string, listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));

describe('text selection settings persistence', () => {
  let root: Root;
  let container: HTMLDivElement;
  const toggle = () => container.querySelector<HTMLInputElement>('[role="switch"]')!;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    mocks.get.mockReset().mockResolvedValue(undefined);
    mocks.set.mockReset().mockImplementation(async (_path: string, value: boolean) => {
      mocks.get.mockResolvedValue(value);
      mocks.listeners.forEach(listener => listener());
    });
    mocks.error.mockReset();
    mocks.listeners.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('persists only the preference leaf and presents the saved value', async () => {
    await act(async () => root.render(<TextSelectionSettingsSection />));
    expect(toggle().checked).toBe(true);
    await act(async () => toggle().click());
    expect(mocks.set).toHaveBeenCalledWith('app.flow_chat.auto_show_selection_toolbar', false);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  });

  it('retains the persisted value and reports a failed save', async () => {
    mocks.set.mockRejectedValue(new Error('Write failed'));
    await act(async () => root.render(<TextSelectionSettingsSection />));
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(true);
    expect(mocks.error).toHaveBeenCalledWith('textSelection.saveFailed');
    expect(toggle().disabled).toBe(false);
  });

  it('shows a retry state on load failure and keeps the switch unavailable until recovery', async () => {
    mocks.get.mockRejectedValue(new Error('Host unavailable'));
    await act(async () => root.render(<TextSelectionSettingsSection />));
    expect(toggle()).toBeNull();
    expect(container.textContent).toContain('textSelection.loadFailed');
    mocks.get.mockResolvedValue(false);
    await act(async () => container.querySelector('button')!.click());
    expect(toggle().checked).toBe(false);
  });
});
