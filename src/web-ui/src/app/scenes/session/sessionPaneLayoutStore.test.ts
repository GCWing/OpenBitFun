import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../layout/panelConfig';
import { createSessionPaneLayoutStore, projectLegacySessionPaneLayout, selectSessionPaneMode } from './sessionPaneLayoutStore';

function preferences(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}

describe('session pane layout', () => {
  it('swaps content without moving the divider, including hide and fullscreen round trips', () => {
    const storage = preferences({ [STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH]: '640' });
    const store = createSessionPaneLayoutStore(storage);
    const pane = store.getState();
    pane.activate('local', 'a');
    pane.showContent();
    pane.swapPanes();
    expect(store.getState().contentSide).toBe('left');
    expect(store.getState().preferredRightPaneWidth).toBe(640);
    pane.maximizeContent();
    pane.showContent(); // Revealing another tab must not exit fullscreen.
    expect(selectSessionPaneMode(store.getState())).toBe('content-only');
    pane.restoreSplit();
    pane.hideContent();
    expect(selectSessionPaneMode(store.getState())).toBe('chat-only');
    pane.showContent();
    expect(store.getState()).toMatchObject({ contentSide: 'left', preferredRightPaneWidth: 640 });
    pane.swapPanes();
    expect(store.getState()).toMatchObject({ contentSide: 'right', preferredRightPaneWidth: 640 });
    expect(storage.setItem.mock.calls.some(([key]) => key === STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH)).toBe(false);
  });

  it('remembers mode per session and device while sharing only placement and width preferences', () => {
    const storage = preferences();
    const store = createSessionPaneLayoutStore(storage);
    const pane = store.getState();
    pane.activate('local', 'a');
    pane.showContent();
    pane.swapPanes();
    pane.resizeRightPane(720);
    pane.maximizeContent();
    pane.activate('peer', 'a');
    expect(selectSessionPaneMode(store.getState())).toBe('chat-only');
    pane.showContent();
    pane.activate('local', 'b');
    expect(selectSessionPaneMode(store.getState())).toBe('chat-only');
    pane.activate('local', 'a');
    expect(selectSessionPaneMode(store.getState())).toBe('content-only');
    pane.activate('peer', 'a');
    expect(selectSessionPaneMode(store.getState())).toBe('split');
    const reopened = createSessionPaneLayoutStore(storage).getState();
    expect(reopened).toMatchObject({ contentSide: 'left', preferredRightPaneWidth: 720 });
    expect(selectSessionPaneMode(reopened)).toBe('chat-only');
  });

  it('normalizes contradictory legacy flags in one update and retains a readable legacy shape', () => {
    const store = createSessionPaneLayoutStore(preferences());
    const changes = vi.fn();
    store.subscribe(changes);
    store.getState().applyLegacyLayout({ chatCollapsed: true, rightPanelCollapsed: false, rightPanelWidth: 640 });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(projectLegacySessionPaneLayout(store.getState())).toEqual({
      chatCollapsed: true, centerPanelCollapsed: false, rightPanelCollapsed: false, rightPanelWidth: 640,
    });
    store.getState().applyLegacyLayout({ rightPanelCollapsed: true, centerPanelCollapsed: true });
    expect(selectSessionPaneMode(store.getState())).toBe('chat-only');
    const snapshot = projectLegacySessionPaneLayout(store.getState());
    const copy = createSessionPaneLayoutStore(preferences());
    copy.getState().applyLegacyLayout(snapshot);
    expect(projectLegacySessionPaneLayout(copy.getState())).toEqual(snapshot);
  });

  it('does not hide the main content surface when its last tab closes in fullscreen', () => {
    const store = createSessionPaneLayoutStore(preferences());
    store.getState().maximizeContent();
    store.getState().collapseEmptyContent();
    expect(selectSessionPaneMode(store.getState())).toBe('content-only');
    store.getState().hideContent();
    expect(projectLegacySessionPaneLayout(store.getState()).chatCollapsed).toBe(false);
    store.getState().showContent();
    store.getState().collapseEmptyContent();
    expect(selectSessionPaneMode(store.getState())).toBe('chat-only');
  });

  it('reads legacy width without rewriting it and leaves invalid preferences intact', () => {
    const storage = preferences({ [STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH]: 'invalid' });
    const store = createSessionPaneLayoutStore(storage);
    const initial = store.getState().preferredRightPaneWidth;
    expect(initial).toBeGreaterThan(0);
    store.getState().resizeRightPane(Number.NaN);
    store.getState().resizeRightPane(-1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH)).toBe('invalid');
    store.getState().resizeRightPane(640);
    store.getState().resizeRightPane(640);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('continues to support all layout actions when preference storage is unavailable', () => {
    const store = createSessionPaneLayoutStore({ getItem: () => { throw Error('unavailable'); }, setItem: () => { throw Error('unavailable'); } });
    store.getState().showContent();
    store.getState().swapPanes();
    store.getState().resizeRightPane(620);
    expect(store.getState()).toMatchObject({ contentSide: 'left', preferredRightPaneWidth: 620 });
  });
});
