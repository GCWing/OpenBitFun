// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import GlobalSearchRoot, { GlobalSearchContent } from './GlobalSearchRoot';
import { useGlobalSearchStore } from './globalSearchStore';
import type { GlobalSearchSnapshot } from './types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fixtures = vi.hoisted(() => ({
  t: (key: string) => key,
  workspaces: [],
  providers: [],
  activate: vi.fn(),
  search: vi.fn(),
  setActiveWorkspace: vi.fn(),
  selectAssistantWorkspace: vi.fn(),
  openAssistant: vi.fn(),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: fixtures.t }) }));
vi.mock('@/infrastructure/hooks/useShortcut', () => ({ useShortcut: vi.fn() }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useWorkspaceContext: () => ({
  currentWorkspace: null, openedWorkspacesList: fixtures.workspaces, setActiveWorkspace: fixtures.setActiveWorkspace,
}) }));
vi.mock('@/app/scenes/my-agent/myAgentStore', () => ({ useMyAgentStore: () => fixtures.selectAssistantWorkspace }));
vi.mock('@/app/scenes/profile/nurseryStore', () => ({ useNurseryStore: () => fixtures.openAssistant }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: vi.fn() } }));
vi.mock('./globalSearchActivator', () => ({ activateGlobalSearchTarget: fixtures.activate }));
vi.mock('./federatedSearchEngine', () => ({ runFederatedSearch: fixtures.search }));
vi.mock('./globalSearchRegistry', () => ({ globalSearchRegistry: {
  subscribe: () => () => {}, getSnapshot: () => fixtures.providers,
} }));
vi.mock('./globalSearchShortcut', () => ({
  GLOBAL_SEARCH_SHORTCUT: 'mod+k', getGlobalSearchShortcutLabel: () => 'Cmd+K',
  splitGlobalSearchShortcutLabel: () => ({ modifier: 'command', key: 'K' }), subscribeGlobalSearchShortcut: () => () => {},
}));

const snapshot: GlobalSearchSnapshot = {
  providerStatus: {}, diagnostics: [], isSearching: false, truncated: false,
  items: [
    { id: 'terminal', providerId: 'actions', group: 'actions', title: 'Open terminal', score: 90, target: { kind: 'action', actionId: 'surface.terminal.open' } },
    { id: 'project', providerId: 'actions', group: 'actions', title: 'Open project', score: 80, target: { kind: 'action', actionId: 'project.open' } },
  ],
};

const diagnosticSnapshot: GlobalSearchSnapshot = { ...snapshot, diagnostics: [{
  providerId: 'files', code: 'workspace_unavailable', message: 'Connection timed out',
  workspaceName: 'Remote project', workspacePath: '/srv/project', hostLabel: 'build-host',
}] };

describe('GlobalSearchContent accessibility', () => {
  let container: HTMLDivElement;
  let root: Root;
  const diagnosticPanel = () => document.querySelector<HTMLElement>('.global-search__diagnostics-panel');
  const diagnosticTrigger = () => document.querySelector<HTMLButtonElement>('[data-testid$="-partial-status"] button')!;
  const key = (target: Element, value: string, isComposing = false) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, isComposing }));
  });
  const renderDiagnostics = async (modal = false) => {
    fixtures.search.mockImplementationOnce((_providers, _request, _signal, onUpdate) => onUpdate(diagnosticSnapshot));
    if (modal) useGlobalSearchStore.getState().openSearch('needle');
    act(() => root.render(modal ? <GlobalSearchRoot /> : <GlobalSearchContent initialQuery="needle" />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    return diagnosticTrigger();
  };
  beforeEach(() => {
    resetDeviceSurfaceForTest();
    useGlobalSearchStore.setState({ open: false, initialQuery: '' });
    vi.useFakeTimers();
    fixtures.activate.mockReset();
    fixtures.search.mockReset();
    fixtures.search.mockImplementation((_providers, _request, _signal, onUpdate) => onUpdate(snapshot));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: false });
    vi.stubGlobal('matchMedia', () => media);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useGlobalSearchStore.setState({ open: false, initialQuery: '' });
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(element => element.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('retains named native actions and tracks keyboard selection in the controlled grid', async () => {
    act(() => root.render(<GlobalSearchContent autoFocus />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const grid = document.getElementById(input.getAttribute('aria-controls')!)!;
    expect(input.getAttribute('aria-haspopup')).toBe('grid');
    expect(grid.getAttribute('role')).toBe('grid');
    const buttons = grid.querySelectorAll('[role="gridcell"] button:not([role])');
    expect([...buttons].map(button => button.getAttribute('aria-label'))).toEqual(['Open terminal', 'Open project']);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const selected = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
    expect(selected.getAttribute('role')).toBe('gridcell');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.textContent).toContain('Open terminal');
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(fixtures.activate).toHaveBeenCalledWith(snapshot.items[0].target, expect.anything());
  });
  it('renders app and entity search hits as actionable cards while keeping content hits in lists', async () => {
    const cardItems: GlobalSearchSnapshot['items'] = [
      snapshot.items[0],
      { id: 'setting', providerId: 'capabilities', group: 'settings', title: 'Appearance settings', score: 90,
        target: { kind: 'capability', capabilityId: 'setting.appearance' } },
      { id: 'feature', providerId: 'capabilities', group: 'capabilities', title: 'Project features', score: 90,
        target: { kind: 'capability', capabilityId: 'feature.projects' } },
      { id: 'workspace', providerId: 'entities', group: 'workspaces', title: 'Project workspace', score: 90,
        target: { kind: 'workspace', workspaceId: 'workspace' } },
      { id: 'assistant', providerId: 'entities', group: 'assistants', title: 'Project assistant', score: 90,
        target: { kind: 'assistant', workspaceId: 'assistant' } },
    ];
    const contentItems: GlobalSearchSnapshot['items'] = [
      { id: 'message', providerId: 'sessions', group: 'messages', title: 'Message match', score: 90,
        target: { kind: 'session', sessionId: 'session', workspaceId: 'workspace', workspacePath: '/project', turnId: 'turn' } },
      { id: 'session', providerId: 'sessions', group: 'sessions', title: 'Session match', score: 90,
        target: { kind: 'session', sessionId: 'session', workspaceId: 'workspace', workspacePath: '/project' } },
      { id: 'file', providerId: 'files', group: 'files', title: 'File match', score: 90,
        target: { kind: 'file', workspaceId: 'workspace', workspacePath: '/project', filePath: '/project/notes.md', fileName: 'notes.md' } },
    ];
    fixtures.search.mockImplementationOnce((_providers, _request, _signal, onUpdate) =>
      onUpdate({ ...snapshot, items: [...cardItems, ...contentItems] }));
    useGlobalSearchStore.getState().openSearch('project');
    act(() => root.render(<GlobalSearchRoot />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const dialog = document.querySelector<HTMLElement>('[data-testid="global-search-dialog"]')!;

    for (const item of cardItems) {
      const group = dialog.querySelector(`[data-search-group="${item.group}"]`)!;
      expect(group.querySelector('[data-search-layout="cards"]')).not.toBeNull();
      expect(group.querySelector('[data-openbitfun-component="action-card"] button')?.getAttribute('aria-label')).toBe(item.title);
    }
    for (const item of contentItems) {
      const group = dialog.querySelector(`[data-search-group="${item.group}"]`)!;
      expect(group.querySelector('[data-search-layout="cards"]')).toBeNull();
      expect(group.querySelector('.global-search__result')?.getAttribute('aria-label')).toBe(item.title);
    }

    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-search-group="settings"] button[aria-label="Appearance settings"]')!.click());
    expect(fixtures.activate).toHaveBeenCalledWith(cardItems[1].target, expect.anything());
    expect(useGlobalSearchStore.getState().open).toBe(false);
  });

  it('shows source diagnostics and retries without clearing the query or healthy results', async () => {
    fixtures.search.mockImplementationOnce((_providers, _request, _signal, onUpdate) => onUpdate(diagnosticSnapshot));
    fixtures.search.mockImplementationOnce((_providers, _request, _signal, onUpdate, retry) =>
      onUpdate({ ...retry.previous, isSearching: true }));
    act(() => root.render(<GlobalSearchContent initialQuery="needle" />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    act(() => diagnosticTrigger().click());
    const panel = diagnosticPanel()!;
    expect(panel.textContent).toContain('Connection timed out');
    expect(panel.textContent).toContain('/srv/project');
    expect(panel.textContent).toContain('build-host');
    act(() => panel.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fixtures.search.mock.calls[1][4]).toEqual({ previous: diagnosticSnapshot, providerIds: ['files'] });
    expect(container.querySelector('input')?.value).toBe('needle');
    expect(container.textContent).toContain('Open terminal');
    expect(panel.querySelector('button')?.disabled).toBe(true);
  });

  it('toggles a named diagnostics portal through its owning trigger', async () => {
    const trigger = await renderDiagnostics();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(diagnosticPanel()).toBeNull();
    act(() => trigger.click());
    const panel = diagnosticPanel()!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-labelledby')).toBe(trigger.id);
    expect(panel.closest('[data-openbitfun-overlay-layer]')).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(document.activeElement).toBe(panel);
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    expect(diagnosticPanel()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['panel', 'query'])('dismisses diagnostics before the real search Dialog with focus in the %s', async (focus) => {
    const trigger = await renderDiagnostics(true);
    act(() => trigger.click());
    const panel = diagnosticPanel()!;
    const dialog = document.querySelector<HTMLElement>('[data-testid="global-search-dialog"]')!;
    const target = focus === 'panel' ? panel : dialog.querySelector<HTMLInputElement>('input')!;
    act(() => target.focus());
    expect(document.activeElement).toBe(target);
    key(target, 'Escape', true);
    expect(diagnosticPanel()).toBe(panel);
    key(target, 'Escape');
    expect(diagnosticPanel()).toBeNull();
    expect(useGlobalSearchStore.getState().open).toBe(true);
    expect(dialog.getAttribute('data-state')).toBe('open');
    expect(document.activeElement).toBe(trigger);
    key(trigger, 'Escape');
    expect(useGlobalSearchStore.getState().open).toBe(false);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(document.querySelector('[data-testid="global-search-dialog"]')).toBeNull();
  });

  it('keeps portalled retry controls inside the modal focus domain and preserves outside focus on dismissal', async () => {
    const trigger = await renderDiagnostics(true);
    act(() => trigger.click());
    const panel = diagnosticPanel()!;
    const retry = panel.querySelector<HTMLButtonElement>('button')!;
    act(() => {
      retry.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      retry.focus();
    });
    expect(diagnosticPanel()).toBe(panel);
    expect(document.activeElement).toBe(retry);
    const input = document.querySelector<HTMLInputElement>('[data-testid="global-search-dialog"] input')!;
    act(() => {
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.focus();
    });
    expect(diagnosticPanel()).toBeNull();
    expect(useGlobalSearchStore.getState().open).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('dismisses only the top layer for each outside pointer gesture', async () => {
    const trigger = await renderDiagnostics(true);
    act(() => trigger.click());
    const backdrop = document.querySelector('[data-testid="global-search-dialog"]')!.parentElement!;
    const clickBackdrop = () => {
      act(() => backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      act(() => backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    };
    clickBackdrop();
    expect(diagnosticPanel()).toBeNull();
    expect(useGlobalSearchStore.getState().open).toBe(true);
    clickBackdrop();
    expect(useGlobalSearchStore.getState().open).toBe(false);
  });

  it('dismisses diagnostics before leaving a group detail page or closing the search Dialog', async () => {
    const grouped: GlobalSearchSnapshot = { ...diagnosticSnapshot, items: ['one', 'two'].map(id => ({
      id, providerId: 'workspaces', group: 'workspaces', title: id, score: 80,
      target: { kind: 'workspace', workspaceId: id },
    })) };
    fixtures.search.mockImplementationOnce((_providers, _request, _signal, onUpdate) => onUpdate(grouped));
    useGlobalSearchStore.getState().openSearch();
    act(() => root.render(<GlobalSearchRoot />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="global-search-group-drilldown-workspaces"]')!.click());
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const view = document.querySelector('.global-search')!;
    expect(view.getAttribute('data-search-view')).toBe('workspaces');
    act(() => diagnosticTrigger().click());
    key(diagnosticPanel()!, 'Escape');
    expect(diagnosticPanel()).toBeNull();
    expect(view.getAttribute('data-search-view')).toBe('workspaces');
    expect(useGlobalSearchStore.getState().open).toBe(true);
    key(diagnosticTrigger(), 'Escape');
    expect(view.getAttribute('data-search-view')).toBe('overview');
    expect(useGlobalSearchStore.getState().open).toBe(true);
    key(diagnosticTrigger(), 'Escape');
    expect(useGlobalSearchStore.getState().open).toBe(false);
  });

  it('clamps diagnostics near viewport edges instead of clipping them to the search container', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('global-search__diagnostics-panel')
        ? new DOMRect(0, 0, 300, 200)
        : new DOMRect(window.innerWidth - 100, window.innerHeight - 40, 80, 24);
    });
    const trigger = await renderDiagnostics(true);
    act(() => trigger.click());
    const panel = diagnosticPanel()!;
    expect(Number.parseFloat(panel.style.left) + 300).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(Number.parseFloat(panel.style.top) + 200).toBeLessThan(window.innerHeight - 40);
    expect(panel.style.visibility).toBe('visible');
  });

  it('removes old-host diagnostics immediately when switching devices', async () => {
    const trigger = await renderDiagnostics(true);
    act(() => trigger.click());
    expect(diagnosticPanel()?.textContent).toContain('/srv/project');
    const [, , signal, publishOld] = fixtures.search.mock.calls[0];
    act(() => activateSurface('peer-b'));
    expect(signal.aborted).toBe(true);
    expect(diagnosticPanel()).toBeNull();
    expect(document.querySelector('[data-testid="global-search-partial-status"]')).toBeNull();
    act(() => publishOld(diagnosticSnapshot));
    expect(diagnosticPanel()).toBeNull();
    expect(document.body.textContent).not.toContain('/srv/project');
  });

  it('discards old results and ignores late completions after a device switch', async () => {
    act(() => root.render(<GlobalSearchContent />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const [, , signal, publishOld] = fixtures.search.mock.calls[0];
    expect(container.textContent).toContain('Open terminal');
    act(() => activateSurface('peer-b'));
    expect(signal.aborted).toBe(true);
    expect(container.textContent).not.toContain('Open terminal');
    act(() => publishOld(snapshot));
    expect(container.textContent).not.toContain('Open terminal');
  });

});
