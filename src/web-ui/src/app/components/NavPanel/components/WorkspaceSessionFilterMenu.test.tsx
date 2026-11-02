// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/i18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { useI18n: () => ({ t: createTestI18nT('common') }) };
});

vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: new Map() }),
    clearSessionUnreadCompletion: vi.fn(),
  },
}));

import WorkspaceSessionFilterMenu from './WorkspaceSessionFilterMenu';
import { matchesWorkspaceSessionView, useWorkspaceSessionViewStore } from '../workspaceSessionView';
import type { Session } from '@/flow_chat/types/flow-chat';

describe('WorkspaceSessionFilterMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    const view = useWorkspaceSessionViewStore.getState();
    view.setGrouping('grouped');
    view.setOrdering('updated');
    view.setShow('all');
    view.resetFilters();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<WorkspaceSessionFilterMenu />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps filtering available while grouping lives in the separate quick toggle', () => {
    const filterButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-session-filter-btn"]',
    );
    expect(filterButton).not.toBeNull();

    act(() => filterButton!.click());
    const workspaceMenu = document.querySelector<HTMLElement>(
      '[data-testid="nav-session-filter-menu"]',
    );
    expect(workspaceMenu).not.toBeNull();
    expect(workspaceMenu?.textContent).not.toContain('Grouping');
    expect(document.querySelector('[data-testid="nav-session-collapse-all"]')).not.toBeNull();

    act(() => filterButton!.click());
    act(() => useWorkspaceSessionViewStore.getState().setGrouping('all'));
    expect(filterButton?.className).not.toContain('is-active');

    act(() => filterButton!.click());
    expect(document.querySelector('[data-testid="nav-session-filter-menu"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="nav-session-collapse-all"]')).toBeNull();
  });

  it.each(['grouped', 'all'] as const)('selects archived sessions and returns to the working list in %s grouping', grouping => {
    act(() => useWorkspaceSessionViewStore.getState().setGrouping(grouping));
    const filterButton = container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!;
    const openShow = () => {
      act(() => filterButton.click());
      act(() => document.querySelector<HTMLButtonElement>('[data-submenu-id="show"]')!.click());
      return document.querySelector<HTMLElement>('[data-testid="nav-session-filter-show-menu"]')!;
    };
    const rows = ['active', 'archived', 'completed'].map(persistedStatus => ({ persistedStatus, config: {} }) as Session);
    const visibleStatuses = () => {
      const { show, filters } = useWorkspaceSessionViewStore.getState();
      return rows.filter(row => matchesWorkspaceSessionView(row, show, filters, false)).map(row => row.persistedStatus);
    };

    const archivedOption = [...openShow().querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(option => option.textContent === 'Archived sessions')!;
    expect(archivedOption).toBeDefined();
    act(() => archivedOption.click());
    expect(visibleStatuses()).toEqual(['archived']);
    expect(useWorkspaceSessionViewStore.getState().grouping).toBe(grouping);
    expect(document.querySelector('[data-testid="nav-session-filter-menu"]')).toBeNull();
    expect(filterButton.getAttribute('data-openbitfun-state')).toBe('filtered');

    const submenu = openShow();
    expect(submenu.querySelector('[aria-checked="true"]')?.textContent).toBe('Archived sessions');
    act(() => [...submenu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(option => option.textContent === 'All sessions')!.click());
    expect(visibleStatuses()).toEqual(['active', 'completed']);
    expect(filterButton.getAttribute('data-openbitfun-state')).toBeNull();
  });

  it('selects a shared session source from the header and resets it with the other filters', () => {
    const filterButton = container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!;
    const openSources = () => {
      act(() => filterButton.click());
      act(() => document.querySelector<HTMLButtonElement>('[data-submenu-id="source"]')!.click());
    };

    openSources();
    const submenu = document.querySelector('[data-testid="nav-session-filter-source-menu"]')!;
    expect(submenu.textContent).toContain('Claude Code');
    expect(submenu.textContent).toContain('DeepSeek Harness');
    expect(submenu.querySelector('[data-testid="nav-session-source-all"]')?.getAttribute('aria-checked')).toBe('false');
    expect(submenu.querySelector('[aria-checked="true"]')?.getAttribute('data-testid')).toBe('nav-session-filter-source-select-all');
    act(() => submenu.querySelector<HTMLButtonElement>('[data-testid="nav-session-source-codex"]')!.click());
    expect(useWorkspaceSessionViewStore.getState().sourceAgent).toBe('codex');
    expect(document.querySelector('[data-testid="nav-session-filter-menu"]')).toBeNull();
    expect(filterButton.getAttribute('data-openbitfun-state')).toBe('filtered');

    act(() => useWorkspaceSessionViewStore.getState().setGrouping('all'));
    openSources();
    expect(document.querySelector('[data-testid="nav-session-source-codex"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-submenu-id="source"] .openbitfun-nav-panel__session-filter-active-dot')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-menu"] button[aria-label="Reset"]')!.click());
    expect(useWorkspaceSessionViewStore.getState().sourceAgent).toBe('all');
    act(() => filterButton.click());
    expect(filterButton.getAttribute('data-openbitfun-state')).toBeNull();
  });

  it.each([
    ['status', 'hiddenStatuses'],
    ['worktree', 'hiddenWorktrees'],
    ['environment', 'hiddenEnvironments'],
    ['source', 'hiddenSources'],
  ] as const)('keeps manual %s choices distinct from the Select All preset without changing other filters', (submenuId, filterKey) => {
    act(() => {
      const view = useWorkspaceSessionViewStore.getState();
      view.setOrdering('name');
      view.setShow('unread');
      view.toggleArchived();
      if (filterKey === 'hiddenStatuses') view.toggleHiddenEnvironment('remote');
      else view.toggleHiddenStatus('error');
      if (submenuId !== 'source') view.setSourceAgent('codex');
    });
    const filtersBefore = useWorkspaceSessionViewStore.getState().filters;
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>(`[data-submenu-id="${submenuId}"]`)!.click());
    const submenu = document.querySelector<HTMLElement>(`[data-testid="nav-session-filter-${submenuId}-menu"]`)!;
    const selectAll = submenu.querySelector<HTMLButtonElement>(`[data-testid="nav-session-filter-${submenuId}-select-all"]`)!;
    const options = [...submenu.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];

    expect(selectAll.textContent).toBe('Select All');
    expect(selectAll.getAttribute('aria-checked')).toBe('true');
    expect([...submenu.querySelectorAll('[aria-checked="true"]')]).toEqual([selectAll]);
    act(() => options[0].click());
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(options.slice(1).every(option => option.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(useWorkspaceSessionViewStore.getState().filters[filterKey]).toHaveLength(options.length - 1);
    for (const option of options.slice(1)) act(() => option.click());
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
    expect(options.every(option => option.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(useWorkspaceSessionViewStore.getState().filters[filterKey]).toEqual([]);
    act(() => options[0].click());
    expect(options[0].getAttribute('aria-checked')).toBe('false');
    expect(options.slice(1).every(option => option.getAttribute('aria-checked') === 'true')).toBe(true);
    act(() => selectAll.click());
    expect(options.every(option => option.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(selectAll.getAttribute('aria-checked')).toBe('true');
    expect([...submenu.querySelectorAll('[aria-checked="true"]')]).toEqual([selectAll]);
    expect(document.querySelector(`[data-testid="nav-session-filter-${submenuId}-menu"]`)).toBe(submenu);

    act(() => options[0].click());
    act(() => options[0].click());
    expect(options.every(option => option.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
    expect(useWorkspaceSessionViewStore.getState().filters[filterKey]).toHaveLength(options.length);
    act(() => selectAll.click());
    expect([...submenu.querySelectorAll('[aria-checked="true"]')]).toEqual([selectAll]);
    act(() => selectAll.click());
    expect(useWorkspaceSessionViewStore.getState()).toMatchObject({
      ordering: 'name', show: 'unread', sourceAgent: submenuId === 'source' ? 'all' : 'codex',
      filters: { ...filtersBefore, [filterKey]: [] },
    });
  });

  it('selects every source category and agent together while preserving status filters', () => {
    act(() => {
      const view = useWorkspaceSessionViewStore.getState();
      view.setSourceAgent('codex');
      view.toggleHiddenStatus('completed');
    });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-submenu-id="source"]')!.click());
    const selectAll = document.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-source-select-all"]')!;
    expect(selectAll.getAttribute('aria-checked')).toBe('false');
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-source-menu"] [role="menuitemcheckbox"]')!.click());
    act(() => selectAll.click());

    expect(selectAll.getAttribute('aria-checked')).toBe('true');
    expect([...document.querySelectorAll('[data-testid="nav-session-filter-source-menu"] [aria-checked="true"]')]).toEqual([selectAll]);
    expect(useWorkspaceSessionViewStore.getState()).toMatchObject({
      sourceAgent: 'all', filters: { hiddenSources: [], hiddenStatuses: ['completed'] },
    });
    expect(document.querySelector('[data-submenu-id="source"] .openbitfun-nav-panel__session-filter-active-dot')).toBeNull();
    expect(document.querySelector('[data-submenu-id="status"] .openbitfun-nav-panel__session-filter-active-dot')).not.toBeNull();
  });

  it('keeps choosing All agents separate from the top-level Select All preset', () => {
    const openSources = () => {
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!.click());
      act(() => document.querySelector<HTMLButtonElement>('[data-submenu-id="source"]')!.click());
    };
    openSources();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="nav-session-source-all"]')!.click());
    openSources();
    expect(document.querySelector('[data-testid="nav-session-filter-source-select-all"]')?.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-testid="nav-session-source-all"]')?.getAttribute('aria-checked')).toBe('true');
    expect([...document.querySelectorAll('[data-testid="nav-session-filter-source-menu"] [role="menuitemcheckbox"]')]
      .every(option => option.getAttribute('aria-checked') === 'true')).toBe(true);
  });

  it.each([
    { side: 'right', parentLeft: 30, submenuLeft: 255, gapX: 252 },
    { side: 'left', parentLeft: 300, submenuLeft: 75, gapX: 298 },
  ])('preserves the $side Portal submenu across a pause in the gap in both directions', ({ parentLeft, submenuLeft, gapX }) => {
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="nav-session-filter-btn"]')!.click());
    const menu = document.querySelector<HTMLElement>('[data-testid="nav-session-filter-menu"]')!;
    const ordering = menu.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    act(() => ordering.click());
    const submenu = document.querySelector<HTMLElement>('[data-testid="nav-session-filter-ordering-menu"]')!;
    expect(container.contains(submenu)).toBe(false);

    for (const [element, left] of [[menu, parentLeft], [submenu, submenuLeft]] as const) {
      element.getBoundingClientRect = () => ({
        left, right: left + 220, top: 20, bottom: 220,
        width: 220, height: 200, x: left, y: 20, toJSON: () => ({}),
      });
    }

    const pauseInGapFrom = (element: HTMLElement) => {
      act(() => {
        element.dispatchEvent(new MouseEvent('pointerout', {
          bubbles: true, relatedTarget: document.body, clientX: gapX, clientY: 80,
        }));
        document.body.dispatchEvent(new MouseEvent('pointermove', {
          bubbles: true, clientX: gapX, clientY: 80,
        }));
      });
      act(() => vi.advanceTimersByTime(1000));
      expect(document.querySelector('[data-testid="nav-session-filter-ordering-menu"]')).toBe(submenu);
    };

    pauseInGapFrom(ordering);
    act(() => submenu.dispatchEvent(new MouseEvent('pointerover', {
      bubbles: true, relatedTarget: document.body, clientX: submenuLeft + 20, clientY: 80,
    })));
    pauseInGapFrom(submenu);

    act(() => document.body.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: gapX, clientY: 400,
    })));
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector('[data-testid="nav-session-filter-ordering-menu"]')).toBeNull();
  });
});
