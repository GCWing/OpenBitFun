// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionScene from './SessionScene';
import { sessionPaneLayoutStore } from './sessionPaneLayoutStore';
import SessionPanelSettingsSection from '../settings/pages/application/SessionPanelSettingsSection';

const mocks = vi.hoisted(() => ({ selectLayout: null as null | ((value: string) => void) }));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Select: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => {
    mocks.selectLayout = onValueChange;
    return <output data-testid="layout-preference">{value}</output>;
  },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useApp', () => ({
  useApp: () => ({ state: { layout: { bottomTerminalPanelCollapsed: true } }, updateBottomTerminalPanelHeight: vi.fn() }),
}));
vi.mock('./ChatPane', () => ({ default: () => <textarea data-testid="chat-draft" defaultValue="draft" /> }));
vi.mock('./AuxPane', () => ({ default: () => <iframe title="Editor" /> }));
vi.mock('./BottomTerminalPane', () => ({ default: () => null }));
vi.mock('./sessionPanelLayout', () => ({ collapseSessionBottomTerminalPane: vi.fn(), expandSessionBottomTerminalPane: vi.fn() }));
vi.mock('@/tools/terminal/services/terminalPanelPreferenceService', () => ({
  getCachedTerminalPanelPosition: () => 'right',
  onTerminalPanelPositionChange: () => () => {},
  refreshTerminalPanelPosition: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('session overlay layout integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  const split = () => container.querySelector<HTMLElement>('[data-openbitfun-component="split-view"][data-openbitfun-part="root"]')!;

  beforeEach(() => {
    sessionPaneLayoutStore.setState(sessionPaneLayoutStore.getInitialState());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return { width: this.getAttribute('data-openbitfun-part') === 'divider' ? 1 : 1201 } as DOMRect;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionPaneLayoutStore.setState(sessionPaneLayoutStore.getInitialState());
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('applies the settings selection to a mounted scene and routes resizing to independent preferences', () => {
    const pane = sessionPaneLayoutStore.getState();
    pane.showContent();
    pane.resizeRightPane(600);
    pane.resizeOverlay(700);
    act(() => root.render(<><SessionScene /><SessionPanelSettingsSection /></>));
    const draft = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-draft"]')!;
    const editor = container.querySelector('iframe');
    draft.value = 'unsent edit';
    expect(split().getAttribute('data-layout')).toBe('split');
    expect(split().style.getPropertyValue('--_split-view-right-size')).toBe('600px');

    act(() => mocks.selectLayout!('overlay'));
    expect(container.querySelector('.openbitfun-session-scene--overlay')).not.toBeNull();
    expect(split().getAttribute('data-layout')).toBe('overlay');
    expect(split().style.getPropertyValue('--_split-view-right-size')).toBe('700px');
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(sessionPaneLayoutStore.getState()).toMatchObject({ preferredOverlayWidth: 710, preferredRightPaneWidth: 600 });
    act(() => pane.swapPanes());
    expect(split().getAttribute('data-secondary-side')).toBe('left');
    act(() => pane.hideContent());
    expect(split().getAttribute('data-mode')).toBe('primary');
    act(() => pane.showContent());
    act(() => pane.maximizeContent());
    expect(split().getAttribute('data-mode')).toBe('secondary');
    act(() => mocks.selectLayout!('split'));
    expect(split().getAttribute('data-mode')).toBe('secondary');
    expect(split().style.getPropertyValue('--_split-view-right-size')).toBe('600px');
    expect(container.querySelector('[data-testid="chat-draft"]')).toBe(draft);
    expect(draft.value).toBe('unsent edit');
    expect(container.querySelector('iframe')).toBe(editor);
  });
});
