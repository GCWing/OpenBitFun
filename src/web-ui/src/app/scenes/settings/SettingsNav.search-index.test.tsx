// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const locale = { current: 'en-US' };

vi.mock('./settingsRegistry', () => {
  const icon = () => null;
  const pages = [
    { id: 'application.general', categoryId: 'application', labelKey: 'General' },
  ].map(page => ({ icon, descriptionKey: 'Description', keywords: [], searchPhrases: [], sections: [], ...page }));
  return {
    DEFAULT_SETTINGS_PAGE_ID: 'application.general',
    SETTINGS_PAGE_MANIFESTS: pages,
    SETTINGS_CATEGORIES: [{ id: 'application', labelKey: 'Application', pages }],
    getSettingsPageManifest: (id: string) => pages.find(page => page.id === id),
    isSettingsPageId: (value: string) => pages.some(page => page.id === value),
    preloadSettingsPage: vi.fn(async () => undefined),
  };
});

vi.mock('react-i18next', () => {
  // A locale switch keeps the i18next instance and only swaps the language, so
  // translated search rows must not outlive the language they were built for.
  const i18n = { get language() { return locale.current; }, getFixedT: () => (key: string) => key };
  return {
    useTranslation: () => ({
      i18n,
      t: (key: string) => (locale.current === 'zh-CN' ? `${key} 中文` : key),
    }),
  };
});
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/utils/motionPreference', () => ({ getInteractionMotion: () => 'instant' }));

import SettingsNav from './SettingsNav';
import { useSettingsStore } from './settingsStore';

describe('SettingsNav search index language', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    locale.current = 'en-US';
    useSettingsStore.setState(useSettingsStore.getInitialState());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<SettingsNav />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    vi.useRealTimers();
  });

  async function search(query: string) {
    const input = container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  }

  it('rebuilds translated search rows after the locale changes', async () => {
    await search('general');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);

    locale.current = 'zh-CN';
    act(() => root.render(<SettingsNav />));
    await search('中文');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  });
});
