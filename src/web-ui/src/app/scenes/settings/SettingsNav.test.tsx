// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createInstance, type i18n as I18nApi } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./settingsRegistry', () => {
  const icon = () => null;
  const pages = [
    { id: 'application.general', categoryId: 'application', labelKey: 'General' },
    {
      id: 'application.appearance', categoryId: 'application', labelKey: 'Appearance',
      searchPhrases: [{ namespace: 'settings/appearance', key: 'themeKeyword' }],
    },
    {
      id: 'application.pet', categoryId: 'application', labelKey: 'Pet & assistant',
      descriptionKey: 'Desktop pet and realtime voice calls',
      sections: [
        { id: 'pet', labelKey: 'Pet', keywords: ['companion'], searchPhrases: [] },
        { id: 'voice-call', labelKey: 'Realtime voice calls', keywords: ['volcengine'], searchPhrases: [] },
      ],
    },
    { id: 'ai.models', categoryId: 'ai', labelKey: 'Models' },
  ].map((page) => ({ icon, descriptionKey: 'Description', keywords: ['settings'], searchPhrases: [], ...page }));
  return {
    DEFAULT_SETTINGS_PAGE_ID: 'application.general',
    SETTINGS_PAGE_MANIFESTS: pages,
    SETTINGS_CATEGORIES: [
      { id: 'application', labelKey: 'Application', pages: pages.slice(0, 3) },
      { id: 'ai', labelKey: 'AI', pages: pages.slice(3) },
    ],
    getSettingsPageManifest: (id: string) => pages.find(page => page.id === id),
    isSettingsPageId: (value: string) => pages.some((page) => page.id === value),
    preloadSettingsPage: vi.fn(async () => undefined),
  };
});

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/utils/motionPreference', () => ({
  getInteractionMotion: () => 'instant',
}));

import SettingsNav from './SettingsNav';
import { preloadSettingsPage } from './settingsRegistry';
import { useSettingsStore } from './settingsStore';
import {
  registerSettingsDraft,
  resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';

describe('SettingsNav shared component composition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let i18n: I18nApi;

  beforeEach(async () => {
    i18n = createInstance();
    await i18n.init({
      lng: 'en-US',
      fallbackLng: 'en-US',
      ns: ['settings', 'shared'],
      resources: {
        'en-US': {
          settings: {
            Application: 'Application', General: 'General', Appearance: 'Appearance',
            'Pet & assistant': 'Pet & assistant', Pet: 'Pet', 'Realtime voice calls': 'Realtime voice calls',
            'Desktop pet and realtime voice calls': 'Desktop pet and realtime voice calls', Models: 'Models',
          },
          shared: { features: { settings: 'Settings' } },
        },
        'zh-CN': { settings: { Appearance: '外观' }, 'settings/appearance': { themeKeyword: '配色' } },
      },
    });
    vi.spyOn(i18n, 'getFixedT');
    vi.useFakeTimers();
    vi.mocked(preloadSettingsPage).mockReset().mockResolvedValue(undefined);
    resetSettingsDraftRegistryForTests();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<I18nextProvider i18n={i18n}><SettingsNav /></I18nextProvider>));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSettingsDraftRegistryForTests();
    vi.useRealTimers();
  });

  async function search(query: string) {
    const input = container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    return input;
  }

  function pressKey(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  it('keeps search outside the scroll area and applies content styles to the real content slot', () => {
    const nav = container.querySelector('nav')!;
    const header = nav.querySelector(':scope > [data-openbitfun-part="header"]')!;
    const viewport = nav.querySelector('[data-openbitfun-component="scroll-area"]')!;
    const content = viewport.querySelector('[data-openbitfun-part="content"]')!;
    expect(nav.getAttribute('aria-label')).toBe('Settings');
    expect(header.querySelector('input')).not.toBeNull();
    expect(viewport.contains(header)).toBe(false);
    expect(content.classList.contains('openbitfun-settings-nav__content')).toBe(true);
    expect(content.querySelectorAll(':scope > section')).toHaveLength(2);
    expect(content.querySelectorAll('[data-openbitfun-part="heading-label"]')).toHaveLength(2);
    const caption = content.querySelector('.openbitfun-settings-nav__category-label')!;
    expect(caption.parentElement?.getAttribute('data-openbitfun-part')).toBe('heading-label');
    expect(content.querySelectorAll('[data-testid="settings-nav-page"]')).toHaveLength(4);
  });

  it('drives the shared selected state from the active destination', async () => {
    const general = container.querySelector<HTMLButtonElement>('[data-settings-page="application.general"]')!;
    const appearance = container.querySelector<HTMLButtonElement>('[data-settings-page="application.appearance"]')!;
    expect(general.getAttribute('aria-current')).toBe('page');
    expect(general.parentElement?.getAttribute('data-openbitfun-component')).toBe('action-item');
    await act(async () => appearance.click());
    expect(useSettingsStore.getState().activePageId).toBe('application.appearance');
    expect(appearance.getAttribute('aria-current')).toBe('page');
    const selectedLabel = appearance.querySelector('[data-openbitfun-part="label"]')!;
    expect(selectedLabel.matches('.openbitfun-settings-nav__item > [data-openbitfun-part="trigger"][aria-current] > [data-openbitfun-part="label"]')).toBe(true);
    expect(selectedLabel.querySelector('.openbitfun-settings-nav__item-label')).not.toBeNull();
    expect(general.hasAttribute('aria-current')).toBe(false);
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector('.is-active')).toBeNull();
  });

  it('keeps two-line search results and keyboard selection working with real navigation items', async () => {
    const input = await search('settings');
    const results = container.querySelector<HTMLDivElement>('[role="listbox"]')!;
    expect(results.querySelectorAll('[role="option"]')).toHaveLength(4);
    const first = results.querySelector('[role="option"]')!;
    const label = first.querySelector('[data-openbitfun-part="label"]')!;
    expect(label.querySelector('.openbitfun-settings-nav__search-result-line')).not.toBeNull();
    expect(label.querySelector('.openbitfun-settings-nav__search-result-desc')).not.toBeNull();
    expect(first.getAttribute('aria-current')).toBe('page');

    await act(async () => pressKey(input, 'ArrowDown'));
    expect(document.activeElement).toBe(results);
    expect(results.getAttribute('aria-activedescendant')).toBe('settings-nav-result-0');
    act(() => pressKey(results, 'ArrowDown'));
    expect(results.getAttribute('aria-activedescendant')).toBe('settings-nav-result-1');
    expect(results.querySelector('.is-highlighted > button')?.id).toBe('settings-nav-result-1');
    await act(async () => pressKey(results, 'Enter'));
    expect(useSettingsStore.getState().activePageId).toBe('application.appearance');
    expect(input.value).toBe('');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('restores grouped navigation after clearing an empty search', async () => {
    const input = await search('no-matching-page');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    act(() => pressKey(input, 'Escape'));
    expect(input.value).toBe('');
    expect(container.querySelectorAll('[data-testid="settings-nav-page"]')).toHaveLength(4);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('defers indexing until search and reuses the index after clearing', async () => {
    const phraseLookups = () => vi.mocked(i18n.getFixedT).mock.calls
      .filter(([, namespace]) => namespace === 'settings/appearance');
    const appearance = container.querySelector<HTMLButtonElement>('[data-settings-page="application.appearance"]')!;

    await act(async () => appearance.click());
    await search('   ');
    expect(phraseLookups()).toHaveLength(0);

    await act(async () => { i18n.addResourceBundle('en-US', 'settings/appearance', { themeKeyword: 'palette' }); });
    expect(phraseLookups()).toHaveLength(0);
    const input = await search('palette');
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Appearance');
    expect(phraseLookups()).toHaveLength(1);

    act(() => pressKey(input, 'Escape'));
    await search('palette');
    expect(phraseLookups()).toHaveLength(1);
  });

  it('refreshes an active search when indexed translations change', async () => {
    await search('palette');
    expect(container.querySelector('[role="option"]')).toBeNull();
    await act(async () => { i18n.addResourceBundle('en-US', 'settings/appearance', { themeKeyword: 'palette' }); });
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Appearance');

    const lookupCount = vi.mocked(i18n.getFixedT).mock.calls.length;
    act(() => i18n.addResourceBundle('en-US', 'unrelated', { label: 'Palette' }));
    expect(i18n.getFixedT).toHaveBeenCalledTimes(lookupCount);

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(container.querySelector('[role="option"]')).toBeNull();
    await search('配色');
    expect(container.querySelector('[role="option"]')?.textContent).toContain('外观');

    act(() => i18n.removeResourceBundle('zh-CN', 'settings/appearance'));
    expect(container.querySelector('[role="option"]')).toBeNull();
  });

  it('keeps unsaved markers outside navigation and search-result text', async () => {
    act(() => {
      registerSettingsDraft({
        id: 'model-proxy',
        pageId: 'ai.models',
        label: 'Proxy',
        dirty: true,
        save: vi.fn(),
        discard: vi.fn(),
      });
    });

    const models = container.querySelector('[data-settings-page="ai.models"]');
    const general = container.querySelector('[data-settings-page="application.general"]');
    const marker = models?.querySelector('[data-openbitfun-part="dirtyMarker"]');
    expect(marker).not.toBeNull();
    expect(marker?.closest('[data-openbitfun-part="metadata"]')?.parentElement).toBe(models);
    expect(models?.querySelector('[data-openbitfun-part="label"]')?.contains(marker!)).toBe(false);
    expect(general?.querySelector('[data-openbitfun-part="dirtyMarker"]')).toBeNull();

    await search('models');
    const result = container.querySelector('[role="option"]')!;
    const resultMarker = result.querySelector('[data-openbitfun-part="dirtyMarker"]')!;
    expect(resultMarker.closest('[data-openbitfun-part="metadata"]')?.parentElement).toBe(result);
    expect(result.querySelector('[data-openbitfun-part="label"]')?.contains(resultMarker)).toBe(false);
  });

  it('opens a matching inline section without matching its siblings through the page description', async () => {
    const input = await search('realtime');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => pressKey(input, 'Enter'));
    expect(useSettingsStore.getState().activePageId).toBe('application.pet');
    expect(useSettingsStore.getState().activeSectionId).toBe('voice-call');
  });

  it('offers the page when only its shared name matches', async () => {
    const input = await search('assistant');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => pressKey(input, 'Enter'));
    expect(useSettingsStore.getState().activePageId).toBe('application.pet');
    expect(useSettingsStore.getState().activeSectionId).toBeNull();
  });
  it('marks a slow destination pending before showing its loading page', async () => {
    vi.mocked(preloadSettingsPage).mockReturnValue(new Promise(() => {}));
    const item = container.querySelector('[data-settings-page="application.appearance"]') as HTMLButtonElement;
    const label = item.querySelector('[data-openbitfun-part="label"]')!;
    const originalLabel = label.innerHTML;
    await act(async () => item.click());
    expect(item.getAttribute('aria-busy')).toBe('true');
    const spinner = item.querySelector('[data-openbitfun-component="spinner"]')!;
    expect(spinner).not.toBeNull();
    expect(spinner.closest('[data-openbitfun-part="metadata"]')?.parentElement).toBe(item);
    expect(label.innerHTML).toBe(originalLabel);
    expect(useSettingsStore.getState().activePageId).toBe('application.general');
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(useSettingsStore.getState().activePageId).toBe('application.appearance');
    expect(item.hasAttribute('aria-busy')).toBe(false);
    expect(item.querySelector('[data-openbitfun-component="spinner"]')).toBeNull();
    expect(label.innerHTML).toBe(originalLabel);
  });

  it('keeps pending search-result indicators outside the two-line copy', async () => {
    vi.mocked(preloadSettingsPage).mockReturnValue(new Promise(() => {}));
    await search('appearance');
    const item = container.querySelector<HTMLButtonElement>('[role="option"]')!;
    const label = item.querySelector('[data-openbitfun-part="label"]')!;
    const originalLabel = label.innerHTML;

    await act(async () => item.click());

    const spinner = item.querySelector('[data-openbitfun-component="spinner"]')!;
    expect(item.getAttribute('aria-busy')).toBe('true');
    expect(spinner).not.toBeNull();
    expect(spinner.closest('[data-openbitfun-part="metadata"]')?.parentElement).toBe(item);
    expect(label.innerHTML).toBe(originalLabel);
    expect(useSettingsStore.getState().activePageId).toBe('application.general');
  });

  it('ignores an earlier click when its preload completes after the latest selection', async () => {
    let finishOld!: () => void;
    vi.mocked(preloadSettingsPage).mockImplementation(pageId => pageId === 'application.appearance'
      ? new Promise<void>(resolve => { finishOld = resolve; }) : Promise.resolve());
    await act(async () => (container.querySelector('[data-settings-page="application.appearance"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[data-settings-page="application.pet"]') as HTMLButtonElement).click());
    await act(async () => finishOld());
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(useSettingsStore.getState().activePageId).toBe('application.pet');
  });

  it('does not override a newer programmatic destination with a pending click', async () => {
    let finish!: () => void;
    vi.mocked(preloadSettingsPage).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => (container.querySelector('[data-settings-page="application.appearance"]') as HTMLButtonElement).click());
    await act(async () => useSettingsStore.getState().openPage('application.pet'));
    await act(async () => finish());
    expect(useSettingsStore.getState().activePageId).toBe('application.pet');
  });

});
