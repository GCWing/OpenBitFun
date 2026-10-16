/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type { MarketListingDetail } from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import { useMiniAppStore } from '../miniAppStore';
import MiniAppLibraryView from './MiniAppLibraryView';

const mocks = vi.hoisted(() => ({
  items: [] as MarketListingDetail[],
  remote: false,
  getListing: vi.fn(), installedStatus: vi.fn(), browse: vi.fn(), install: vi.fn(),
  openApp: vi.fn(), deleteMiniApp: vi.fn(), error: vi.fn(), success: vi.fn(),
  systemInstall: vi.fn(), progress: vi.fn(),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string) => key, currentLanguage: 'en-US', formatNumber: String,
}) }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: {}, workspacePath: '/project' }) }));
vi.mock('@/shared/types', () => ({ isRemoteWorkspace: () => mocks.remote }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => mocks }));
vi.mock('@/infrastructure/account-identity', () => ({ useAccountIdentity: () => ({ me: null }) }));
vi.mock('@/features/market-account', () => ({ AccountIdentityControls: () => null }));
vi.mock('@/app/hooks/useSceneManager', () => ({ useSceneManager: () => ({ openTabs: [], closeScene: vi.fn() }) }));
vi.mock('@/app/hooks/useGallerySceneAutoRefresh', () => ({ useGallerySceneAutoRefresh: () => undefined }));
vi.mock('../hooks/useMiniAppActivity', () => ({ useMiniAppActivity: () => [] }));
vi.mock('../hooks/useMiniAppCreation', () => ({ useMiniAppCreation: () => ({ creating: false, createMiniApp: vi.fn() }) }));
vi.mock('../hooks/useMiniAppLaunch', () => ({ useMiniAppLaunch: () => ({ supported: !mocks.remote, busyAppIds: [], openApp: mocks.openApp }) }));
vi.mock('../components/MiniAppSystemAppActions', () => ({ MiniAppSystemAppActions: () => null }));
vi.mock('@/shared/utils/motionPreference', () => ({ getInteractionMotion: () => 'none' }));
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/MiniAppMarketAPI', () => ({ miniAppMarketAPI: {
  ...mocks, getCachedPage: () => ({ items: mocks.items }),
} }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({
  hasLocalMiniAppPresentation: () => false, miniAppPresentationAPI: { install: mocks.systemInstall },
}));
vi.mock('../utils/miniAppSystemIcon', () => ({ renderMiniAppSystemIcon: () => '<svg />' }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {} }));
vi.mock('@/app/components/GalleryLayout/MarketImage', () => ({ MarketImage: ({ source, alt }: any) => <img src={source} alt={alt} /> }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(vi.fn()) }) }));

const app: MiniAppMeta = {
  id: 'notes', name: 'Notes', description: 'Write notes', icon: 'box', category: 'utilities',
  tags: [], version: 1, permissions: {}, created_at: 1, updated_at: 1,
};
const listing: MarketListingDetail = {
  listingId: 'timer', slug: 'timer', name: 'Timer', description: 'Focus timer', icon: 'box',
  category: 'utilities', tags: [], owner: { githubId: 1, login: 'author', avatarUrl: '' },
  latestRelease: 1, minOpenBitFunVersion: '1.0.0', permissions: {},
  screenshotUrls: ['https://example.com/timer.png'], ratingAverage: 4, ratingCount: 2,
  favoriteCount: 0, downloadCount: 1, publishedAt: 1, changelog: 'First release',
  license: { spdxExpression: 'MIT' }, releases: [],
};
let root: Root;
let container: HTMLDivElement;
const page = () => container.querySelector<HTMLElement>('[data-testid="miniapp-detail-page"]');
const button = (text: string, parent: ParentNode = container) => [...parent.querySelectorAll('button')].find(item => item.textContent === text)!;
const render = (catalog: 'installed' | 'market' = 'installed') => act(async () => {
  root.render(<MiniAppLibraryView catalog={catalog} />);
});
const openMarketDetail = () => act(async () => {
  container.querySelector<HTMLButtonElement>('.miniapp-library-row__details')!.click();
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.remote = false;
  mocks.items = [listing];
  mocks.getListing.mockResolvedValue(listing);
  mocks.installedStatus.mockResolvedValue(null);
  mocks.deleteMiniApp.mockReset().mockResolvedValue(undefined);
  mocks.browse.mockResolvedValue({ items: [listing] });
  mocks.install.mockResolvedValue({ app, origin: { listingId: listing.listingId, releaseId: 'r1', releaseNumber: 1, packageSha256: '' } });
  mocks.systemInstall.mockResolvedValue({ path: '/Applications/Notes.app' });
  mocks.progress.mockReturnValue({ complete: mocks.success, fail: mocks.error, cancel: vi.fn() });
  useMiniAppStore.setState({ apps: [app], loading: false, marketOrigins: {}, customizingAppIds: [], runningWorkerIds: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MiniApp detail page navigation', () => {
  it('uses notification-center feedback when adding a system app from the card menu', async () => {
    await render();
    const more = container.querySelector<HTMLButtonElement>('[aria-label="presentation.moreActions"]')!;
    await act(async () => more.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="presentation.moreActions"]')!;
    await act(async () => button('presentation.install', menu).click());
    expect(mocks.systemInstall).toHaveBeenCalledExactlyOnceWith('notes', '/project', '<svg />');
    expect(mocks.progress).toHaveBeenCalledWith({
      title: 'presentation.install', message: 'presentation.installing', progressMode: 'text-only',
    });
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('presentation.installed');
  });

  it('opens market details in the scene and restores the list position and focus on return', async () => {
    await render('market');
    const search = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Timer');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const scrollArea = container.querySelector<HTMLElement>('.gallery-layout__body')!;
    scrollArea.scrollTop = 180;
    const trigger = container.querySelector<HTMLButtonElement>('.miniapp-library-row__details')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(page()?.querySelector('h1')?.textContent).toBe('Timer');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.closest('[hidden]')).not.toBeNull();
    expect(scrollArea.scrollTop).toBe(0);
    expect(document.activeElement).toBe(page());
    await act(async () => button('detail.back').click());
    expect(page()).toBeNull();
    expect(trigger.closest('[hidden]')).toBeNull();
    expect(scrollArea.scrollTop).toBe(180);
    expect(document.activeElement).toBe(trigger);
    expect(search.value).toBe('Timer');
  });

  it('separates installed card details from launch and confirmed deletion', async () => {
    await render();
    const card = container.querySelector('.miniapp-installed-card')!;
    const launch = card.querySelector<HTMLButtonElement>('[aria-label="card.start"]')!;
    const remove = async () => {
      await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="presentation.moreActions"]')!.click());
      const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="presentation.moreActions"]')!;
      await act(async () => button('card.delete', menu).click());
    };
    expect(card.querySelectorAll('[data-openbitfun-part="actions"] button')).toHaveLength(2);
    expect(launch.dataset.openbitfunVariant).toBe('glass');
    expect(launch.dataset.openbitfunShape).toBe('circle');
    expect(launch.dataset.size).toBe('standard');
    await act(async () => card.querySelector<HTMLButtonElement>('.miniapp-installed-card__content')!.click());
    expect(page()?.querySelector('h1')?.textContent).toBe('Notes');
    expect(mocks.openApp).not.toHaveBeenCalled();
    await act(async () => button('detail.back').click());
    await act(async () => launch.click());
    expect(mocks.openApp).toHaveBeenCalledWith('notes', 'tab', 'box');
    expect(page()).toBeNull();
    expect(mocks.getListing).not.toHaveBeenCalled();

    await remove();
    let confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    expect(mocks.deleteMiniApp).not.toHaveBeenCalled();
    await act(async () => button('confirmDelete.cancel', confirm).click());
    expect(useMiniAppStore.getState().apps).toHaveLength(1);
    expect(mocks.deleteMiniApp).not.toHaveBeenCalled();

    await remove();
    confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    await act(async () => button('confirmDelete.confirm', confirm).click());
    expect(mocks.deleteMiniApp).toHaveBeenCalledWith('notes');
    expect(useMiniAppStore.getState().apps).toHaveLength(0);
    expect(page()).toBeNull();
  });

  it('opens a supplied homepage app directly in details and returns through its caller', async () => {
    const onBack = vi.fn();
    useMiniAppStore.setState({ apps: [] });
    await act(async () => root.render(<MiniAppLibraryView catalog="installed" initialDetailApp={app}
      onDetailBack={onBack} detailBackLabel="Back home" />));
    expect(page()?.querySelector('h1')?.textContent).toBe('Notes');
    expect(mocks.openApp).not.toHaveBeenCalled();
    await act(async () => button('Back home').click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(page()).toBeNull();
  });

  it.each(['tab', 'window'] as const)('waits for a destination choice before launching details in a %s', async kind => {
    await act(async () => root.render(<MiniAppLibraryView catalog="installed" initialDetailApp={app} />));
    const start = button('detail.start', page()!);
    expect(start.dataset.openbitfunVariant).toBe('outline');
    expect(start.getAttribute('aria-expanded')).toBe('false');
    await act(async () => start.click());
    expect(page()).not.toBeNull();
    expect(mocks.openApp).not.toHaveBeenCalled();
    expect(start.getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="detail.start"]')!;
    expect(menu).not.toBeNull();
    await act(async () => button(kind === 'tab' ? 'presentation.openTab' : 'presentation.openWindow', menu).click());
    expect(mocks.openApp).toHaveBeenCalledExactlyOnceWith('notes', kind, 'box');
    expect(page()).toBeNull();
  });

  it('disables the independent-window menu choice on remote surfaces and permits in-app launch', async () => {
    mocks.remote = true;
    await act(async () => root.render(<MiniAppLibraryView catalog="installed" initialDetailApp={app} />));
    await act(async () => button('detail.start', page()!).click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="detail.start"]')!;
    const windowChoice = button('presentation.openWindow', menu);
    expect(windowChoice.disabled).toBe(true);
    await act(async () => windowChoice.click());
    expect(mocks.openApp).not.toHaveBeenCalled();
    await act(async () => button('presentation.openTab', menu).click());
    expect(mocks.openApp).toHaveBeenCalledExactlyOnceWith('notes', 'tab', 'box');
  });

  it('requires confirmation before uninstalling from details', async () => {
    await act(async () => root.render(<MiniAppLibraryView catalog="installed" initialDetailApp={app} />));
    await act(async () => button('detail.uninstall', page()!).click());
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    expect(mocks.deleteMiniApp).not.toHaveBeenCalled();
    await act(async () => button('confirmDelete.confirm', confirm).click());
    expect(mocks.deleteMiniApp).toHaveBeenCalledExactlyOnceWith('notes');
    expect(page()).toBeNull();
  });

  it('loads marketplace content into the page and retains explicit install confirmation', async () => {
    await render('market');
    await openMarketDetail();
    expect(page()?.querySelector('h1')?.textContent).toBe('Timer');
    expect(page()?.querySelector('img')?.getAttribute('src')).toBe(listing.screenshotUrls[0]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button('market.library.get', page()!).click());
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
    await act(async () => button('market.confirmInstall.confirm', confirm).click());
    expect(mocks.install).toHaveBeenCalledWith('timer', 1, expect.objectContaining({ confirmPermissions: true }));
    expect(page()?.querySelector('h1')?.textContent).toBe('Timer');
    expect(mocks.openApp).not.toHaveBeenCalled();
  });

  it('ignores a pending marketplace response after returning to the list', async () => {
    let finish!: (detail: MarketListingDetail) => void;
    mocks.getListing.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render('market');
    await openMarketDetail();
    expect(page()?.getAttribute('aria-busy')).toBe('true');
    await act(async () => button('detail.back').click());
    await act(async () => finish(listing));
    expect(page()).toBeNull();
    expect(container.querySelector('.miniapp-library-row__details')?.closest('[hidden]')).toBeNull();
  });

  it('keeps workspace-dependent apps unavailable to launch from a remote workspace', async () => {
    mocks.remote = true;
    useMiniAppStore.setState({ apps: [{ ...app, permissions: { fs: { read: ['{workspace}'] } } }] });
    await render();
    const launch = container.querySelector<HTMLButtonElement>('.miniapp-installed-card [aria-label="card.start"]')!;
    expect(launch.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="presentation.moreActions"]')!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="presentation.moreActions"]')!;
    expect(button('card.delete', menu).disabled).toBe(false);
    expect(button('presentation.install', menu).disabled).toBe(true);
    await act(async () => button('presentation.install', menu).click());
    expect(mocks.systemInstall).not.toHaveBeenCalled();
    await act(async () => launch.click());
    expect(mocks.openApp).not.toHaveBeenCalled();
  });
});
