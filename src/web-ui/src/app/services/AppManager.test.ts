import { describe, expect, it, vi } from 'vitest';

import { AppManager } from './AppManager';
import { createSessionPaneLayoutStore, selectSessionPaneMode } from '../scenes/session/sessionPaneLayoutStore';

describe('AppManager layout updates', () => {
  it('does not emit layout changes when the requested layout is already current', () => {
    const manager = new AppManager();
    const listener = vi.fn();
    manager.addEventListener(listener);
    const current = manager.getState().layout;

    manager.updateLayout({
      leftPanelActiveTab: current.leftPanelActiveTab,
      leftPanelCollapsed: current.leftPanelCollapsed,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('emits layout changes when a layout value changes', () => {
    const manager = new AppManager();
    const listener = vi.fn();
    manager.addEventListener(listener);
    const current = manager.getState().layout;

    manager.updateLayout({
      leftPanelCollapsed: !current.leftPanelCollapsed,
    });

    expect(listener).toHaveBeenCalledWith({
      type: 'layout:changed',
      payload: {
        leftPanelCollapsed: !current.leftPanelCollapsed,
      },
    });
  });

  it('projects pane state and normalizes legacy writes without emitting intermediate flags', () => {
    const panes = createSessionPaneLayoutStore();
    const manager = new AppManager(panes);
    const listener = vi.fn();
    manager.addEventListener(listener);
    manager.updateLayout({ chatCollapsed: true, rightPanelWidth: 650 });
    expect(selectSessionPaneMode(panes.getState())).toBe('content-only');
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'layout:changed', payload: {
      chatCollapsed: true, centerPanelCollapsed: false, rightPanelCollapsed: false, rightPanelWidth: 650,
    } });
    listener.mockClear();
    panes.getState().hideContent();
    expect(manager.getState().layout).toMatchObject({ chatCollapsed: false, rightPanelCollapsed: true, rightPanelWidth: 650 });
    expect(listener).toHaveBeenCalledTimes(1);
    manager.destroy();
    listener.mockClear();
    panes.getState().showContent();
    expect(listener).not.toHaveBeenCalled();
  });
});
