// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./settingsRegistry', () => {
  const pages = [
    { id: 'application.general', categoryId: 'application', labelKey: 'General' },
    { id: 'application.appearance', categoryId: 'application', labelKey: 'Appearance' },
    {
      id: 'application.pet', categoryId: 'application', labelKey: 'Pet & assistant',
      descriptionKey: 'Desktop pet and realtime voice calls',
      sections: [
        { id: 'pet', labelKey: 'Pet', keywords: ['companion'], searchPhrases: [] },
        { id: 'voice-call', labelKey: 'Realtime voice calls', keywords: ['volcengine'], searchPhrases: [] },
      ],
    },
    { id: 'ai.models', categoryId: 'ai', labelKey: 'Models' },
  ].map((page) => ({ descriptionKey: 'Description', keywords: ['settings'], searchPhrases: [], ...page }));
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

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  const i18n = { language: 'en-US', getFixedT: () => t };
  return { useTranslation: () => ({ t, i18n }) };
});
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/utils/motionPreference', () => ({
  getInteractionMotion: () => 'instant',
}));

import SettingsNav from './SettingsNav';
import { useSettingsStore } from './settingsStore';
import {
  registerSettingsDraft,
  resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';

describe('SettingsNav shared component composition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    resetSettingsDraftRegistryForTests();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<SettingsNav />));
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
    expect(nav.getAttribute('aria-label')).toBe('shared:features.settings');
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

  it('marks only pages that currently own an unsaved draft', () => {
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
    expect(models?.querySelector('[data-openbitfun-part="dirtyMarker"]')).not.toBeNull();
    expect(general?.querySelector('[data-openbitfun-part="dirtyMarker"]')).toBeNull();
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
});
