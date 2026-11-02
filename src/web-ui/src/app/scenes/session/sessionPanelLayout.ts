import { useSceneStore } from '../../stores/sceneStore';
import { appManager } from '../../services/AppManager';
import { sessionPaneLayoutStore } from './sessionPaneLayoutStore';
import { selectedSessionTab, tabPane } from '../../workbench/scenePaneModel';

/** Canvas reveal shares the workbench's draft guard and navigation transaction. */
export function expandSessionAuxPane(): void {
  useSceneStore.getState().revealCanvas();
}

export function collapseSessionAuxPane(): void {
  const scenes = useSceneStore.getState();
  if (scenes.canvasPane !== 'secondary' || scenes.openTabs.some(tab => tab.pane === 'secondary')) return;
  sessionPaneLayoutStore.getState().collapseEmptyContent();
}

/** An explicit hide also restores chat when the pane occupies the content area. */
export function hideSessionAuxPane(): void {
  sessionPaneLayoutStore.getState().hideContent();
}

export function expandSessionBottomTerminalPane(height: number): void {
  const panes = sessionPaneLayoutStore.getState();
  const session = selectedSessionTab(useSceneStore.getState());
  panes.revealPanes([session ? tabPane(session) : 'primary']);
  appManager.updateLayout({
    bottomTerminalPanelHeight: height,
    bottomTerminalPanelCollapsed: false,
  });
}

export function collapseSessionBottomTerminalPane(): void {
  appManager.updateLayout({ bottomTerminalPanelCollapsed: true });
}
