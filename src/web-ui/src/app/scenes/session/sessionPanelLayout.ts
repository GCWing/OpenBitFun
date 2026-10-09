import { appManager } from '../../services/AppManager';
import { selectSessionPaneMode, sessionPaneLayoutStore } from './sessionPaneLayoutStore';

/** Explicit, synchronous layout writes remain safe when open requests repeat. */
export function expandSessionAuxPane(): void {
  sessionPaneLayoutStore.getState().showContent();
}

export function collapseSessionAuxPane(): void {
  sessionPaneLayoutStore.getState().collapseEmptyContent();
}

/** An explicit hide also restores chat when the pane occupies the content area. */
export function hideSessionAuxPane(): void {
  sessionPaneLayoutStore.getState().hideContent();
}

export function expandSessionBottomTerminalPane(height: number): void {
  const panes = sessionPaneLayoutStore.getState();
  if (selectSessionPaneMode(panes) === 'content-only') panes.restoreSplit();
  appManager.updateLayout({
    bottomTerminalPanelHeight: height,
    bottomTerminalPanelCollapsed: false,
  });
}

export function collapseSessionBottomTerminalPane(): void {
  appManager.updateLayout({ bottomTerminalPanelCollapsed: true });
}
