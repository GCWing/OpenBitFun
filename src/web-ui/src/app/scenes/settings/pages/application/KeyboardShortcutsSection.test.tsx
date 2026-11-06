// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutManager } from '@/infrastructure/services/ShortcutManager';
import { resetSettingsDraftRegistryForTests } from '@/infrastructure/config/settingsDraftRegistry';
import KeyboardShortcutsSection from './KeyboardShortcutsSection';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key === 'keyboard.shortcuts.tab.close' ? 'Close tab' : key }) }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { getConfig: vi.fn(async () => ({})), setConfig: vi.fn(async () => {}) },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('keyboard shortcut recording ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  const close = vi.fn();
  const press = async (target: HTMLElement, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true, ...extra });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };
  const record = async () => {
    const row = [...container.querySelectorAll<HTMLElement>('[data-openbitfun-part="item"]')]
      .find(item => item.textContent?.includes('Close tab'))!;
    const button = row.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    await act(async () => { button.focus(); button.click(); });
    return button;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetSettingsDraftRegistryForTests();
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    shortcutManager.clear();
    shortcutManager.setEnabled(true);
    shortcutManager.loadUserOverrides({});
    shortcutManager.register('tab.close', { key: 'w', ctrl: true, scope: 'app', allowInInput: true }, close,
      { description: 'keyboard.shortcuts.tab.close' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<KeyboardShortcutsSection />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    shortcutManager.clear();
    resetSettingsDraftRegistryForTests();
    vi.restoreAllMocks();
  });

  it.each(['Win32', 'MacIntel'])('records the close binding without executing it on %s, then restores dispatch', async platform => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    const modifier = platform === 'MacIntel' ? { ctrlKey: false, metaKey: true } : { ctrlKey: true };
    const button = await record();
    const laterListener = vi.fn();
    window.addEventListener('keydown', laterListener, true);
    try {
      expect((await press(button, modifier)).defaultPrevented).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(laterListener).not.toHaveBeenCalled();
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(container.textContent).toContain('keyboard.apply');
      await press(button, modifier);
      expect(close).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('keydown', laterListener, true); }
  });

  it.each([{ repeat: true }, { isComposing: true }, { keyCode: 229 }])('keeps recording while ignoring held keys and IME: %o', async extra => {
    const button = await record();
    await press(button, extra);
    expect(close).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await press(button, { key: 'Escape', ctrlKey: false });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not capture keys belonging to another region while settings stays mounted', async () => {
    const button = await record();
    await press(document.body);
    expect(close).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('releases capture when the section unmounts', async () => {
    await record();
    await act(async () => root.render(null));
    await press(document.body);
    expect(close).toHaveBeenCalledOnce();
  });
});
