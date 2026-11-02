// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SceneChromeHost,
  SceneChromeProvider,
} from '@/app/components/SceneTopBar/SceneChrome';
import { FlowChatHeader, type FlowChatHeaderProps } from './FlowChatHeader';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { PeerHostCapabilities } from '@/infrastructure/peer-device/PeerConnectionManager';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const peer = vi.hoisted(() => ({ active: false, capabilities: null as Partial<PeerHostCapabilities> | null }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => peer.active
    ? { peerMode: { active: true }, currentPeerCapabilities: peer.capabilities }
    : null,
}));

const {
  createReviewPlatformPullRequestDetailTabMock,
  createReviewPlatformTabMock,
  getWorkspaceSnapshotMock,
  isGitRepositoryMock,
} = vi.hoisted(() => ({
  createReviewPlatformPullRequestDetailTabMock: vi.fn(),
  createReviewPlatformTabMock: vi.fn(),
  getWorkspaceSnapshotMock: vi.fn(),
  isGitRepositoryMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => {
  const ReactModule = await import('react');

  return {
    ...await importOriginal<typeof import('@openbitfun/ui')>(),
    Tooltip: ({ children }: { children: React.ReactNode }) => (
      <ReactModule.Fragment>{children}</ReactModule.Fragment>
    ),
    IconButton: ReactModule.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
      icon?: React.ReactNode;
      shape?: string;
      size?: string;
      tooltip?: string;
      variant?: string;
    }>(({
      children,
      icon,
      shape,
      size,
      tooltip,
      variant,
      ...props
    }, ref) => (
      <button
        ref={ref}
        type="button"
        title={tooltip}
        data-openbitfun-shape={shape}
        data-openbitfun-variant={variant}
        data-size={size}
        {...props}
      >
        {icon}
        {children}
      </button>
    )),
    Input: ReactModule.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => (
      <input ref={ref} {...props} />
    )),
  };
});

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    currentWorkspace: { id: 'workspace-1', rootPath: '/workspace' },
  }),
}));

vi.mock('@/infrastructure/api', () => ({
  gitAPI: {
    isGitRepository: isGitRepositoryMock,
  },
  reviewPlatformAPI: {
    getWorkspaceSnapshot: getWorkspaceSnapshotMock,
  },
}));

vi.mock('@/shared/utils/tabUtils', () => ({
  createReviewPlatformPullRequestDetailTab: createReviewPlatformPullRequestDetailTabMock,
  createReviewPlatformTab: createReviewPlatformTabMock,
}));

vi.mock('./SessionFilesBadge', () => ({
  SessionFilesBadge: () => <div data-testid="session-files-badge" />,
}));

vi.mock('./SessionTreePopover', () => ({
  SessionTreePopover: ({ embedded, activeOnly }: { embedded?: boolean; activeOnly?: boolean }) => embedded
    ? <div data-testid="flowchat-header-session-tree-content" data-active-only={activeOnly} />
    : null,
}));

function createProps(overrides: Partial<FlowChatHeaderProps> = {}): FlowChatHeaderProps {
  return {
    visible: true,
    ...overrides,
  };
}

describe('FlowChatHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    activateSurface('local');
    peer.active = false;
    peer.capabilities = null;
    isGitRepositoryMock.mockReset();
    isGitRepositoryMock.mockResolvedValue(true);
    getWorkspaceSnapshotMock.mockReset();
    getWorkspaceSnapshotMock.mockResolvedValue({
      pullRequests: [],
      pagination: { total: 0 },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the inline fallback hidden until the session has content', () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps({ visible: false })} />);
    });

    expect(container.querySelector('.flowchat-header')).toBeNull();

    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });

    expect(container.querySelector('.flowchat-header')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="message"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="turnBadge"]')).toBeNull();
  });

  it('contributes only active Session actions to the shared scene top bar', () => {
    const renderInScene = (activeSceneId: 'session' | 'settings', visible = false) => {
      root.render(
        <SceneChromeProvider activeSceneId={activeSceneId}>
          <SceneChromeHost data-testid="scene-actions-host" />
          <FlowChatHeader
            {...createProps({
              visible,
              onToggleRightPanel: vi.fn(),
            })}
          />
        </SceneChromeProvider>,
      );
    };

    act(() => renderInScene('session'));

    const host = container.querySelector('[data-testid="scene-actions-host"]');
    expect(host?.querySelector('[data-testid="session-files-badge"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-search"]')).toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-session-overview"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-right-panel"]')).toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-session-overview"] [data-openbitfun-name="settings"]')).not.toBeNull();

    act(() => renderInScene('settings'));
    expect(host?.childElementCount).toBe(0);

    act(() => renderInScene('session', true));
    expect(host?.querySelector('[data-testid="flowchat-header-search"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-search"] [data-openbitfun-name="search"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="flowchat-header-search"]')?.getAttribute('data-size')).toBe('xs');
    expect(host?.querySelector('[data-testid="flowchat-header-session-overview"]')?.getAttribute('data-size')).toBe('xs');
  });

  it('omits the list, previous-turn, and next-turn navigation controls', () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });

    expect(container.querySelector('[data-testid="flowchat-header-turn-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-turn-prev"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-turn-next"]')).toBeNull();
  });

  it('hosts trajectory search and its navigation in the shared scene top bar', () => {
    const onTrajectoryOpen = vi.fn(); const onSearchNext = vi.fn(); const onSearchClose = vi.fn();
    const render = (trajectoryOpen: boolean) => root.render(
      <SceneChromeProvider activeSceneId="session">
        <SceneChromeHost data-testid="scene-actions-host" />
        <FlowChatHeader {...createProps({ onTrajectoryOpen, trajectoryOpen, searchQuery: 'needle',
          searchMatchCount: 3, searchCurrentMatch: 1, onSearchNext, onSearchClose })} />
      </SceneChromeProvider>,
    );
    act(() => render(false));
    const host = container.querySelector('[data-testid="scene-actions-host"]')!;
    expect(host.querySelector('[data-openbitfun-name="chart-spline"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-search"]')!.click());
    expect(onTrajectoryOpen).toHaveBeenCalledTimes(1);
    act(() => render(true));
    const search = host.querySelector('[data-testid="flowchat-header-search-bar"]')!;
    expect(search.querySelector('input')?.value).toBe('needle');
    act(() => search.querySelector<HTMLButtonElement>('[aria-label="flowChatHeader.searchNext"]')!.click());
    expect(onSearchNext).toHaveBeenCalledTimes(1);
    act(() => search.querySelector<HTMLButtonElement>('.flowchat-header__search-close')!.click());
    expect(onSearchClose).toHaveBeenCalledTimes(1);
    act(() => render(false));
    expect(host.querySelector('[data-testid="flowchat-header-search-bar"]')).toBeNull();
  });

  it('toggles the host-owned right panel from the session header', () => {
    const onToggleRightPanel = vi.fn();
    const onSearchClose = vi.fn();

    act(() => {
      root.render(<FlowChatHeader {...createProps({ onSearchClose, onToggleRightPanel })} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-right-panel"]',
    );
    expect(trigger?.getAttribute('aria-label')).toBe('common:header.expandRightPanel');
    expect(trigger?.getAttribute('aria-pressed')).toBe('false');
    expect(trigger?.getAttribute('data-openbitfun-state')).toBe('collapsed');
    expect(trigger?.querySelector('[data-openbitfun-name="sidebar-right"]')).not.toBeNull();
    const getRightActions = () => container.querySelector(
      '.flowchat-header__actions:not(.flowchat-header__actions--left)',
    );
    const actionTestIds = () => [...(getRightActions()?.children ?? [])].map((action) => (
      action.getAttribute('data-testid')
      ?? action.querySelector('[data-testid]')?.getAttribute('data-testid')
    ));
    expect(actionTestIds()).toEqual([
      'flowchat-header-search',
      'flowchat-header-session-overview',
      'flowchat-header-right-panel-separator',
      'flowchat-header-right-panel',
    ]);
    expect(getRightActions()?.lastElementChild).toBe(trigger);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-search"]')?.click();
    });
    expect(actionTestIds()).toEqual(['flowchat-header-search-bar']);
    expect(container.querySelector('.flowchat-header')?.classList.contains('flowchat-header--searching')).toBe(true);
    expect(container.querySelector('[data-testid="session-files-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-session-overview"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-right-panel"]')).toBeNull();

    const searchBar = container.querySelector('[data-testid="flowchat-header-search-bar"]');
    const searchField = searchBar?.querySelector('[data-openbitfun-component="search-field"]');
    const searchInput = searchField?.querySelector('input');
    const searchClose = searchBar?.querySelector<HTMLButtonElement>('.flowchat-header__search-close');
    expect(searchField).not.toBeNull();
    expect(searchBar?.getAttribute('data-openbitfun-state')).toBe('active');
    expect(searchInput?.type).toBe('search');
    expect(searchInput?.placeholder).toBe('flowChatHeader.searchPlaceholder');
    expect(searchBar?.querySelector('[data-openbitfun-part="searchControls"]')).not.toBeNull();
    expect(searchClose?.getAttribute('data-openbitfun-shape')).toBe('circle');
    expect(searchClose?.querySelector('[data-openbitfun-name="xmark"]')).not.toBeNull();

    act(() => {
      searchClose?.click();
    });
    expect(onSearchClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="session-files-badge"]')).not.toBeNull();
    expect(actionTestIds()).toEqual([
      'flowchat-header-search',
      'flowchat-header-session-overview',
      'flowchat-header-right-panel-separator',
      'flowchat-header-right-panel',
    ]);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-right-panel"]')?.click();
    });
    expect(onToggleRightPanel).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <FlowChatHeader
          {...createProps({
            isRightPanelOpen: true,
            onToggleRightPanel,
          })}
        />,
      );
    });

    const openTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-right-panel"]',
    );
    expect(openTrigger?.getAttribute('aria-label')).toBe('common:header.collapseRightPanel');
    expect(openTrigger?.getAttribute('aria-pressed')).toBe('true');
    expect(openTrigger?.getAttribute('data-openbitfun-state')).toBe('open');
    expect(openTrigger?.classList.contains('flowchat-header__right-panel-trigger--active')).toBe(true);
    expect(openTrigger?.querySelector('[data-openbitfun-name="sidebar-right"]')).not.toBeNull();
  });

  it('keeps match navigation on Enter while the compact search field is open', () => {
    const onSearchClose = vi.fn();
    const onSearchNext = vi.fn();
    const onSearchPrev = vi.fn();

    act(() => {
      root.render(<FlowChatHeader {...createProps({
        onSearchClose,
        onSearchNext,
        onSearchPrev,
      })} />);
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-search"]')?.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      '[data-testid="flowchat-header-search-bar"] input',
    );
    act(() => {
      searchInput?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      searchInput?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        shiftKey: true,
      }));
    });
    expect(onSearchNext).toHaveBeenCalledTimes(1);
    expect(onSearchPrev).toHaveBeenCalledTimes(1);

    act(() => {
      searchInput?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(onSearchClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="flowchat-header-search-bar"]')).toBeNull();
  });

  it('expands results without replacing the input and disables navigation for no matches', () => {
    const onSearchClose = vi.fn();
    const onSearchNext = vi.fn();
    const onSearchPrev = vi.fn();
    const renderSearch = (searchQuery = '', searchMatchCount = 0, searchCurrentMatch = 0) => {
      act(() => {
        root.render(<FlowChatHeader {...createProps({
          searchOpenRequest: 1,
          searchQuery,
          searchMatchCount,
          searchCurrentMatch,
          onSearchClose,
          onSearchNext,
          onSearchPrev,
        })} />);
      });
    };

    renderSearch();
    const searchField = container.querySelector('[data-openbitfun-component="search-field"]');
    const searchInput = searchField?.querySelector('input');
    expect(searchField?.getAttribute('data-variant')).toBe('default');
    expect(searchField?.querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    searchInput?.focus();

    renderSearch('device', 7, 1);
    expect(searchField?.getAttribute('data-variant')).toBe('panel');
    expect(searchField?.querySelector('input')).toBe(searchInput);
    expect(document.activeElement).toBe(searchInput);
    expect(searchField?.querySelector('.flowchat-header__search-status')?.textContent)
      .toBe('flowChatHeader.searchResult');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('flowChatHeader.searchResult');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

    const previous = searchField?.querySelector<HTMLButtonElement>('[aria-label="flowChatHeader.searchPrevious"]');
    const next = searchField?.querySelector<HTMLButtonElement>('[aria-label="flowChatHeader.searchNext"]');
    expect(previous?.querySelector('[data-openbitfun-name="arrow-up"]')).not.toBeNull();
    expect(next?.querySelector('[data-openbitfun-name="arrow-down"]')).not.toBeNull();
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      previous?.dispatchEvent(mouseDown);
      previous?.click();
      next?.click();
    });
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(searchInput);
    expect(onSearchPrev).toHaveBeenCalledTimes(1);
    expect(onSearchNext).toHaveBeenCalledTimes(1);

    renderSearch('missing');
    expect(searchField?.getAttribute('data-variant')).toBe('panel');
    expect(searchField?.querySelector('.flowchat-header__search-status')?.textContent)
      .toBe('flowChatHeader.searchNoResults');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);
    act(() => {
      previous?.click();
      next?.click();
    });
    expect(onSearchPrev).toHaveBeenCalledTimes(1);
    expect(onSearchNext).toHaveBeenCalledTimes(1);

    renderSearch('   ');
    expect(searchField?.getAttribute('data-variant')).toBe('default');
    expect(searchField?.querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    expect(searchField?.querySelector('input')).toBe(searchInput);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="flowchat-header-session-overview"]')).toBeNull();

    renderSearch('device', 7, 2);
    act(() => {
      searchField?.querySelector<HTMLButtonElement>('[aria-label="flowChatHeader.searchNext"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(onSearchClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="flowchat-header-search-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-session-overview"]')).not.toBeNull();
  });

  it('shows Agents, background terminals, and pull requests as one default list', async () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps({ sessionId: 'session-1' })} />);
    });

    expect(container.querySelector('[data-testid="flowchat-header-session-tree"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-background-commands"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-pull-requests"]')).toBeNull();

    const overviewButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-overview"]',
    );
    expect(overviewButton?.querySelector('[data-openbitfun-name="settings"]')).not.toBeNull();
    expect(overviewButton?.querySelector('.lucide-activity')).toBeNull();
    await act(async () => {
      overviewButton?.click();
      await Promise.resolve();
    });

    const panel = document.querySelector('[data-testid="flowchat-header-session-overview-panel"]');
    expect(panel?.hasAttribute('data-openbitfun-native-webview-occlusion')).toBe(true);
    const items = [...(panel?.querySelector(
      '.flowchat-header__session-overview-list',
    )?.children ?? [])] as HTMLElement[];
    expect(items.map(item => item.dataset.testid)).toEqual([
      'flowchat-header-session-tree-section',
      'flowchat-header-background-commands',
      'flowchat-header-pull-requests',
    ]);
    const sectionHeaders = panel?.querySelectorAll(
      '.flowchat-header__session-overview-section-header',
    ) ?? [];
    expect([...sectionHeaders].every(header => header.querySelector('svg') === null)).toBe(true);
    expect(panel?.querySelector('.flowchat-header__session-overview-item-meta')).toBeNull();
    expect(items[2]?.querySelector('svg')).toBeNull();
    expect(panel?.querySelector('[data-testid="flowchat-header-session-tree-content"]')).not.toBeNull();
    expect(panel?.querySelector('[data-testid="flowchat-header-background-empty"]')?.textContent)
      .toBe('flowChatHeader.backgroundCommandEmpty');
    expect(panel?.querySelector('[data-testid="flowchat-header-pull-requests-empty"]')?.textContent)
      .toBe('flowChatHeader.pullRequestEmpty');
    expect(panel?.querySelector('[data-testid="flowchat-header-session-overview-back"]')).toBeNull();
    const activeSwitch = panel?.querySelector<HTMLInputElement>('[aria-label="flowChatHeader.agentTreeActiveOnly"]');
    expect(activeSwitch?.checked).toBe(true);
    expect(panel?.querySelector('[data-testid="flowchat-header-session-tree-content"]')?.getAttribute('data-active-only')).toBe('true');
    await act(async () => activeSwitch?.click());
    expect(activeSwitch?.checked).toBe(false);
    expect(panel?.querySelector('[data-testid="flowchat-header-session-tree-content"]')?.getAttribute('data-active-only')).toBe('false');
  });

  it('shows the empty background terminal state without navigating', async () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });

    const commandSection = document.querySelector<HTMLElement>(
      '[data-testid="flowchat-header-background-commands"]',
    );

    const panel = document.querySelector<HTMLElement>('.flowchat-header__session-overview-panel');
    expect(commandSection?.textContent).toContain('flowChatHeader.backgroundCommandEmpty');
    expect(panel?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(panel?.style.visibility).toBe('visible');
    expect(panel?.hasAttribute('data-openbitfun-view')).toBe(false);
  });

  it('keeps the open overview attached while its pane is resized or collapsed', async () => {
    vi.useFakeTimers();
    let anchorLeft = 480;
    const observers = new Map<object, { targets: Set<Element>; notify: () => void }>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(notify: () => void) { observers.set(this, { targets: new Set(), notify }); }
      observe(target: Element) { observers.get(this)!.targets.add(target); }
      unobserve(target: Element) { observers.get(this)!.targets.delete(target); }
      disconnect() { observers.delete(this); }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'flowchat-header-session-overview') return new DOMRect(anchorLeft, 20, 24, 24);
      if (this.dataset.testid === 'flowchat-header-session-overview-panel') return new DOMRect(0, 0, 360, 240);
      return new DOMRect();
    });
    try {
      act(() => root.render(<FlowChatHeader {...createProps()} />));
      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-session-overview"]')!;
      await act(async () => { trigger.click(); });
      const panel = document.querySelector<HTMLElement>('[data-testid="flowchat-header-session-overview-panel"]')!;
      expect(panel.style.left).toBe('144px');

      // Only the containing pane resizes: the trigger stays 24 x 24, and
      // neither a window resize nor a new render announces its movement.
      for (const nextLeft of [560, 640, 900]) {
        anchorLeft = nextLeft;
        act(() => {
          observers.forEach(observer => {
            if (observer.targets.has(container)) observer.notify();
          });
          vi.advanceTimersByTime(20);
        });
        expect(panel.style.left).toBe(`${anchorLeft + 24 - 360}px`);
        expect(panel.style.top).toBe('52px');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
      }
      act(() => trigger.click());
      expect([...observers.values()].some(observer => observer.targets.has(container))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the Agent tree immediately without a back-navigation state', async () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps({ sessionId: 'session-1' })} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });

    const panel = document.querySelector<HTMLElement>(
      '[data-testid="flowchat-header-session-overview-panel"]',
    );
    expect(panel?.querySelector('[data-testid="flowchat-header-session-tree-content"]')).not.toBeNull();
    expect(panel?.querySelector('[data-testid="flowchat-header-session-overview-back"]')).toBeNull();
  });

  it('renders background command menus in a portal outside the scrollable panel', async () => {
    const onStopBackgroundCommand = vi.fn();
    const onStopAllBackgroundCommands = vi.fn();

    act(() => {
      root.render(
        <FlowChatHeader
          {...createProps({
            backgroundCommands: [{
              execSessionKey: 'command-1',
              execSessionId: 1,
              title: 'Long-running command',
              command: 'pnpm dev',
              status: 'running',
            }],
            onStopBackgroundCommand,
            onStopAllBackgroundCommands,
          })}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });

    const panel = document.querySelector('.flowchat-header__session-overview-panel');
    const menuButton = panel?.querySelector<HTMLButtonElement>(
      '.flowchat-header__session-overview-section-actions [aria-label="flowChatHeader.backgroundCommandActions"]',
    );
    expect(panel?.querySelector('.flowchat-header__background-section-title')).toBeNull();
    expect(menuButton?.closest('.flowchat-header__session-overview-section-header')).not.toBeNull();
    act(() => {
      menuButton?.click();
    });

    const menu = document.querySelector<HTMLDivElement>('[data-testid="flowchat-header-background-menu"]');
    expect(menu).not.toBeNull();
    expect(panel?.contains(menu ?? null)).toBe(false);
    expect(menu?.classList.contains('flowchat-header__background-command-menu--portal')).toBe(true);

    act(() => {
      menu?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('.flowchat-header__session-overview-panel')).not.toBeNull();

    const stopButton = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    act(() => {
      stopButton?.click();
    });

    expect(onStopAllBackgroundCommands).toHaveBeenCalledTimes(1);
  });

  it('uses the overview activity dot only for work that is still running', () => {
    const finishedCommand: FlowChatHeaderProps['backgroundCommands'] = [{
      execSessionKey: 'command-1',
      execSessionId: 1,
      title: 'Finished command',
      command: 'pnpm test',
      status: 'exited',
    }];

    act(() => {
      root.render(<FlowChatHeader {...createProps({ backgroundCommands: finishedCommand })} />);
    });
    expect(container.querySelector('.flowchat-header__session-overview-status-dot')).toBeNull();

    act(() => {
      root.render(<FlowChatHeader {...createProps({
        backgroundCommands: [{ ...finishedCommand[0], status: 'running' }],
      })} />);
    });
    expect(container.querySelector('.flowchat-header__session-overview-status-dot')).not.toBeNull();
  });

  it('opens pull requests from the overview list and closes the popover', async () => {
    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-pull-requests"] .flowchat-header__session-overview-section-header--action',
      )?.click();
    });

    expect(createReviewPlatformTabMock).toHaveBeenCalledWith('workspace-1', '/workspace');
    expect(document.querySelector('[data-testid="flowchat-header-session-overview-panel"]')).toBeNull();
  });

  it.each([null, { hostKind: 'cli' }, { hostKind: 'desktop', reviewPlatformV1: false }] as const)(
    'disables unsupported peer PR overview without querying its workspace: %j', async capabilities => {
      peer.active = true;
      peer.capabilities = capabilities;
      act(() => root.render(<FlowChatHeader {...createProps()} />));
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click());

      const section = document.querySelector('[data-testid="flowchat-header-pull-requests"]');
      expect(section?.textContent).toContain('common:reviewPlatform.messages.hostUnsupported');
      expect(section?.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
      expect(isGitRepositoryMock).not.toHaveBeenCalled();
      expect(getWorkspaceSnapshotMock).not.toHaveBeenCalled();
    },
  );

  it('stops an old workspace probe before sending a PR request to a newly selected CLI peer', async () => {
    let resolveGit!: (value: boolean) => void;
    isGitRepositoryMock.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveGit = resolve; }));
    act(() => root.render(<FlowChatHeader {...createProps()} />));
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-overview"]',
    )?.click());

    await act(async () => {
      peer.active = true;
      peer.capabilities = { hostKind: 'cli' };
      activateSurface('cli-peer');
      root.render(<FlowChatHeader {...createProps()} />);
      resolveGit(true);
    });
    expect(getWorkspaceSnapshotMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="flowchat-header-pull-requests"]')?.textContent)
      .toContain('common:reviewPlatform.messages.hostUnsupported');
  });

  it('reloads the same workspace ID on a device switch and ignores the previous device response', async () => {
    let resolveOld!: (value: unknown) => void;
    getWorkspaceSnapshotMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    act(() => root.render(<FlowChatHeader {...createProps()} />));
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-overview"]',
    )?.click());
    expect(getWorkspaceSnapshotMock).toHaveBeenCalledTimes(1);

    getWorkspaceSnapshotMock.mockResolvedValueOnce({
      pullRequests: [{ id: '52', number: 52, title: 'Selected device PR' }], pagination: { total: 1 },
    });
    await act(async () => {
      peer.active = true;
      peer.capabilities = { hostKind: 'desktop' };
      activateSurface('desktop-peer');
      root.render(<FlowChatHeader {...createProps()} />);
    });
    await act(async () => resolveOld({
      pullRequests: [{ id: '42', number: 42, title: 'Departed device PR' }], pagination: { total: 1 },
    }));
    expect(getWorkspaceSnapshotMock).toHaveBeenCalledTimes(2);
    const section = document.querySelector('[data-testid="flowchat-header-pull-requests"]');
    expect(section?.textContent).toContain('Selected device PR');
    expect(section?.textContent).not.toContain('Departed device PR');
  });

  it('shows compact pull request rows and opens the selected request', async () => {
    getWorkspaceSnapshotMock.mockResolvedValueOnce({
      pullRequests: [{
        id: '42',
        providerId: 'origin:github:openbitfun',
        number: 42,
        title: 'Keep status lists compact',
        webUrl: 'https://example.test/pull/42',
      }],
      pagination: { total: 1 },
    });

    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });

    const pullRequestItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-pull-request-item"]',
    );
    expect(pullRequestItem?.textContent).toBe('#42 Keep status lists compact');
    expect(
      pullRequestItem?.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="chevron-right"]'),
    ).not.toBeNull();

    act(() => {
      pullRequestItem?.click();
    });

    expect(getWorkspaceSnapshotMock).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', repositoryPath: '/workspace' },
      null,
      1,
      3,
    );
    expect(createReviewPlatformPullRequestDetailTabMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      remoteId: 'origin:github:openbitfun',
      pullRequestId: '42',
      pullRequestUrl: 'https://example.test/pull/42',
      title: '#42 Keep status lists compact',
    });
    expect(document.querySelector('[data-testid="flowchat-header-session-overview-panel"]')).toBeNull();
  });

  it('shows a distinct unavailable state for non-Git workspaces without loading pull requests', async () => {
    isGitRepositoryMock.mockResolvedValueOnce(false);

    act(() => {
      root.render(<FlowChatHeader {...createProps()} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="flowchat-header-session-overview"]',
      )?.click();
      await Promise.resolve();
    });

    const section = document.querySelector<HTMLElement>(
      '[data-testid="flowchat-header-pull-requests"]',
    );
    const unavailable = section?.querySelector<HTMLElement>(
      '[data-testid="flowchat-header-pull-requests-unavailable"]',
    );
    const headerButton = section?.querySelector<HTMLButtonElement>(
      '.flowchat-header__session-overview-section-header--action',
    );

    expect(section?.dataset.openbitfunState).toBe('unavailable');
    expect(unavailable?.textContent).toBe('flowChatHeader.pullRequestNotGitRepository');
    expect(headerButton?.disabled).toBe(true);
    expect(getWorkspaceSnapshotMock).not.toHaveBeenCalled();
  });
});
