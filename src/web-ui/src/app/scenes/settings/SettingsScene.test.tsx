// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const preparation = vi.hoisted(() => ({
  ready: vi.fn(() => true),
  preload: vi.fn(async (_pageId: string) => undefined),
  loading: vi.fn(),
}));
vi.mock('./pages/shared/SettingsPage', () => ({
  SettingsPage: ({ pageId, children }: { pageId: string; children: React.ReactNode }) => <section><h2>{pageId}</h2>{children}</section>,
}));
vi.mock('@/infrastructure/config/components/common', () => ({
  ConfigLoadingState: () => { preparation.loading(); return <div data-testid="pending-page" />; },
  ConfigRetryState: ({ onRetry }: { onRetry: () => void }) => <button data-testid="retry-page" onClick={onRetry}>Retry</button>,
}));

vi.mock('./settingsRegistry', () => {
  const pages = {
    'application.general': {
      id: 'application.general',
      categoryId: 'application',
      component: ({ viewId, isActive }: { viewId?: string; isActive?: boolean }) => (
        <div
          data-testid="general-page"
          data-view={viewId}
          data-settings-scene-active={isActive ? 'true' : 'false'}
        />
      ),
    },
    'application.appearance': {
      id: 'application.appearance',
      categoryId: 'application',
      component: () => <div data-testid="appearance-page" />,
    },
    'tools.automation': {
      id: 'tools.automation',
      categoryId: 'tools',
      sections: [{ id: 'hooks' }],
      component: ({ sectionId }: { sectionId?: string }) => <div data-testid="automation-page" data-section={sectionId} />,
    },
  };
  return {
    DEFAULT_SETTINGS_PAGE_ID: 'application.general',
    getSettingsPageManifest: (pageId: keyof typeof pages) => pages[pageId] ?? pages['application.general'],
    isSettingsPageId: (value: string) => value in pages,
    isSettingsPageReady: preparation.ready,
    preloadSettingsPage: preparation.preload,
  };
});

import SettingsScene from './SettingsScene';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useSettingsStore } from './settingsStore';
import {
  registerSettingsDraft,
  resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';

describe('SettingsScene canonical page routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    preparation.ready.mockReset().mockReturnValue(true);
    preparation.preload.mockReset().mockResolvedValue(undefined);
    preparation.loading.mockClear();
    resetSettingsDraftRegistryForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useSettingsStore.setState({
      activePageId: 'application.general',
      activeViewId: null,
      activeSectionId: null,
      navigationRequestId: 0,
      pageTransitionTarget: null,
      pageTransitionMotion: 'instant',
      pageTransitionSequence: 0,
      searchQuery: '',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSettingsDraftRegistryForTests();
  });

  it('renders the active canonical page', async () => {
    await act(async () => root.render(<SettingsScene />));
    expect(container.querySelector('[data-testid="general-page"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-page="application.general"]')).not.toBeNull();
  });

  it('migrates an old internal view to an inline section without creating a sidebar page', async () => {
    useSettingsStore.getState().openDestination({
      pageId: 'tools.automation',
      viewId: 'hooks',
    });
    await act(async () => root.render(<SettingsScene />));
    expect(container.querySelector('[data-testid="automation-page"]')?.getAttribute('data-section')).toBe('hooks');
  });

  it('switches pages without retaining the outgoing page for instant navigation', async () => {
    await act(async () => root.render(<SettingsScene />));
    await act(async () => useSettingsStore.getState().openPage('application.appearance'));
    expect(container.querySelector('[data-testid="appearance-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="general-page"]')).toBeNull();
  });

  it('passes scene activation changes to the active settings page', async () => {
    await act(async () => root.render(<SettingsScene isActive={false} />));
    expect(container.querySelector('[data-testid="general-page"]')?.getAttribute(
      'data-settings-scene-active',
    )).toBe('false');

    await act(async () => root.render(<SettingsScene isActive />));
    expect(container.querySelector('[data-testid="general-page"]')?.getAttribute(
      'data-settings-scene-active',
    )).toBe('true');
  });

  it('saves registered drafts before committing a page change', async () => {
    const save = vi.fn(async () => true);
    registerSettingsDraft({
      id: 'general-form',
      pageId: 'application.general',
      label: 'General form',
      dirty: true,
      save,
      discard: vi.fn(),
    });
    await act(async () => root.render(<SettingsScene />));

    await act(async () => useSettingsStore.getState().openPage('application.appearance'));
    expect(useSettingsStore.getState().activePageId).toBe('application.general');
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="settings-unsaved-navigation-dialog"]',
    );
    expect(dialog?.textContent).toContain('General form');

    const confirmButton = dialog?.querySelectorAll<HTMLButtonElement>('button').item(2);
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().activePageId).toBe('application.appearance');
  });
  it('never mounts loading UI while switching between prepared pages', async () => {
    await act(async () => root.render(<SettingsScene />));
    const frame = container.querySelector('.openbitfun-settings-scene__content-wrapper');
    await act(async () => useSettingsStore.getState().openPage('application.appearance', 'pointer'));
    await act(async () => useSettingsStore.getState().openPage('application.general', 'pointer'));
    expect(preparation.loading).not.toHaveBeenCalled();
    expect(container.querySelector('.openbitfun-settings-scene__content-wrapper')).toBe(frame);
    expect(container.querySelectorAll('[data-testid="settings-scene-content"]')).toHaveLength(1);
  });

  it('keeps the latest destination when cold imports complete out of order', async () => {
    let finishAppearance!: () => void;
    let finishAutomation!: () => void;
    preparation.ready.mockReturnValue(false);
    preparation.preload.mockImplementation(pageId => new Promise<void>(resolve => {
      if (pageId === 'application.appearance') finishAppearance = resolve;
      else finishAutomation = resolve;
    }));
    useSettingsStore.getState().openPage('application.appearance');
    await act(async () => root.render(<SettingsScene />));
    await act(async () => useSettingsStore.getState().openPage('tools.automation'));
    await act(async () => finishAppearance());
    expect(container.querySelector('h2')?.textContent).toBe('tools.automation');
    expect(container.querySelector('[data-testid="appearance-page"]')).toBeNull();
    await act(async () => finishAutomation());
    expect(container.querySelector('[data-testid="automation-page"]')).not.toBeNull();
  });

  it('shows an in-place retry when preparation fails and recovers without leaving settings', async () => {
    preparation.ready.mockReturnValue(false);
    preparation.preload.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<SettingsScene />));
    expect(container.querySelector('[data-testid="retry-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="general-page"]')).toBeNull();
    await act(async () => (container.querySelector('[data-testid="retry-page"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="general-page"]')).not.toBeNull();
  });

  it('replaces page-local state synchronously on device activation', async () => {
    await act(async () => root.render(<SettingsScene />));
    const oldPage = container.querySelector('[data-testid="general-page"]');
    await act(async () => activateSurface('peer-settings-test'));
    expect(container.querySelector('[data-testid="general-page"]')).not.toBe(oldPage);
  });

});
