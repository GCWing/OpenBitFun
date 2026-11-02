// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { sidebarPreferences } from '@/app/navigation/sidebarPreferences';
import { sidebarRegistry } from '@/app/navigation/sidebarContributions';
import { useSidebarNavigation } from '@/app/navigation/useSidebarNavigation';
import { useSkillsSceneStore } from '@/app/scenes/skills/skillsSceneStore';
import { useSceneStore } from '@/app/stores/sceneStore';
import PinnedNavigationItems from '@/app/components/NavPanel/components/PinnedNavigationItems';
import SidebarSettingsSection from './SidebarSettingsSection';

const mocks = vi.hoisted(() => ({ openScene: vi.fn(), desktop: true }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, options?: { name?: string; id?: string }) => `${key}${options?.name ? `:${options.name}` : options?.id ? `:${options.id}` : ''}`,
}) }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: vi.fn() } }));
vi.mock('@/app/stores/sceneStore', async () => {
  const { create } = await import('zustand');
  return { useSceneStore: create(() => ({ activeTabId: 'personal-overview', openScene: mocks.openScene })) };
});
vi.mock('@/app/global-search/productActionActivator', () => ({ activateProductAction: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let dispose: (() => void) | undefined;
function Navigation() { return <aside><PinnedNavigationItems navigation={useSidebarNavigation()} /></aside>; }
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const pinIds = () => [...host.querySelectorAll('aside [data-testid]')].map(item => item.getAttribute('data-testid'));

beforeEach(() => {
  vi.clearAllMocks();
  resetDeviceSurfaceForTest();
  mocks.desktop = true;
  localStorage.clear();
  sidebarPreferences.setState({ pinnedIds: ['builtin.todos'], storageIssue: null });
  useSkillsSceneStore.setState(useSkillsSceneStore.getInitialState(), true);
  useSceneStore.setState({ activeTabId: 'personal-overview' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<><SidebarSettingsSection /><Navigation /></>));
});
afterEach(() => {
  act(() => { root.unmount(); dispose?.(); });
  dispose = undefined;
  host.remove();
  resetDeviceSurfaceForTest();
});

it('applies pinning, keyboard-accessible ordering, removal and reset immediately', async () => {
  const capsules = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-available-page"]')];
  expect(capsules).toHaveLength(6);
  expect(host.querySelector('#sidebar-navigation input')).toBeNull();
  expect(capsules.every(item => item.getAttribute('data-openbitfun-variant') === 'outline')).toBe(true);
  expect(host.querySelector('#sidebar-navigation [data-openbitfun-part="sectionDescription"]')).toBeNull();
  capsules[0].focus();
  act(() => button('sidebar.addEntry:common:nav.items.miniApps').click());
  expect(document.activeElement).toBe(button('sidebar.addEntry:common:nav.items.skills'));
  expect(pinIds()).toEqual(['nav-todos-btn', 'nav-builtin.miniapps']);
  act(() => button('sidebar.moveUp:common:nav.items.miniApps').click());
  expect(pinIds()).toEqual(['nav-builtin.miniapps', 'nav-todos-btn']);
  await act(async () => button('common:nav.items.miniApps').click());
  const { activateProductAction } = await import('@/app/global-search/productActionActivator');
  expect(activateProductAction).toHaveBeenCalledWith('surface.miniapps.open');
  act(() => button('sidebar.remove:common:nav.items.todos').click());
  expect(pinIds()).toEqual(['nav-builtin.miniapps']);
  act(() => [...host.querySelectorAll('button')].find(item => item.textContent === 'sidebar.reset')!.click());
  expect(pinIds()).toEqual(['nav-todos-btn']);
  for (const capsule of host.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-available-page"]')) {
    act(() => capsule.click());
  }
  expect(host.querySelector('[data-testid="sidebar-available-page"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe('sidebar.reset');
});

it('retains unavailable contributions, then restores them in the same position on registration', () => {
  act(() => sidebarPreferences.getState().setPinned('example.page', true));
  expect(button('nav.customization.unavailableEntry:example.page').disabled).toBe(true);
  act(() => { dispose = sidebarRegistry.register({
    id: 'example.page', labelKey: 'common:scenes.browser', icon: 'browser', isActive: () => false, open: vi.fn(),
  }); });
  expect(button('common:scenes.browser').disabled).toBe(false);
  expect(pinIds()).toEqual(['nav-todos-btn', 'nav-example.page']);
  act(() => dispose?.());
  expect(sidebarPreferences.getState().pinnedIds).toContain('example.page');
  expect(button('nav.customization.unavailableEntry:example.page').disabled).toBe(true);
});

it('hides the retired external import shortcut while retaining saved preferences', () => {
  act(() => sidebarPreferences.getState().setPinned('builtin.external-import', true));
  expect(pinIds()).toEqual(['nav-todos-btn']);
  expect(host.textContent).not.toContain('builtin.external-import');
  expect(sidebarPreferences.getState().pinnedIds).toContain('builtin.external-import');
});

it('follows skills subpage changes and retains disabled pins across simulated peer switches', async () => {
  act(() => {
    sidebarPreferences.getState().setPinned('builtin.skills.installed', true);
    sidebarPreferences.getState().setPinned('builtin.skills.discover', true);
    useSceneStore.setState({ activeTabId: 'skills' });
  });
  expect(button('common:nav.items.skills').getAttribute('data-openbitfun-state')).toBe('active');
  await act(async () => button('common:nav.items.discoverSkills').click());
  expect(useSkillsSceneStore.getState().activeTab).toBe('discover');
  expect(mocks.openScene).toHaveBeenCalledWith('skills');
  expect(button('common:nav.items.discoverSkills').getAttribute('data-openbitfun-state')).toBe('active');
  act(() => activateSurface('peer-a'));
  expect(button('common:nav.items.discoverSkills').disabled).toBe(true);
  expect(sidebarPreferences.getState().pinnedIds).toContain('builtin.skills.discover');
  act(() => activateSurface('local'));
  expect(button('common:nav.items.discoverSkills').disabled).toBe(false);
});

it('does not open a destination on a different device after lazy preparation', async () => {
  const entry = sidebarRegistry.getSnapshot().find(item => item.id === 'builtin.skills.discover')!;
  let current = true;
  const pending = entry.open({ isCurrent: () => current });
  current = false;
  await pending;
  expect(mocks.openScene).not.toHaveBeenCalled();
  expect(useSkillsSceneStore.getState().activeTab).toBe('installed');
});
