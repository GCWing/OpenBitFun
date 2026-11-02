import { getSceneViewId, type SceneTab, type SceneTabId } from '../components/SceneBar/types';

export type WorkbenchPane = 'primary' | 'secondary';
export type PaneSelection = { kind: 'scene'; tabId: SceneTabId } | { kind: 'canvas' } | { kind: 'empty' };
export type PaneSelections = Record<WorkbenchPane, PaneSelection>;
export const workbenchPanes = ['primary', 'secondary'] as const;
export const tabPane = (tab: SceneTab): WorkbenchPane => tab.pane ?? 'primary';
export const otherPane = (pane: WorkbenchPane): WorkbenchPane => pane === 'primary' ? 'secondary' : 'primary';
export const sceneSelection = (tabId: SceneTabId): PaneSelection => ({ kind: 'scene', tabId });
export const selectedScene = (selection: PaneSelection): SceneTabId | null => selection.kind === 'scene' ? selection.tabId : null;

export interface ScenePaneState {
  openTabs: SceneTab[];
  paneSelections: PaneSelections;
  focusedPane: WorkbenchPane;
  canvasPane: WorkbenchPane;
}

export function paneFallback(tabs: SceneTab[], pane: WorkbenchPane, excludedView?: SceneTabId): SceneTabId | null {
  return tabs.filter(tab => tabPane(tab) === pane && getSceneViewId(tab.id) !== excludedView)
    .sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id ?? null;
}

export function vacantSelection(pane: WorkbenchPane, canvasPane: WorkbenchPane): PaneSelection {
  return { kind: pane === canvasPane ? 'canvas' : 'empty' };
}

/** Repair membership only. Focus/history changes never select hidden content. */
export function reconcilePaneState(state: ScenePaneState): ScenePaneState {
  const paneSelections = { ...state.paneSelections };
  const fallback = (pane: WorkbenchPane, excludedView?: SceneTabId) => {
    const id = paneFallback(state.openTabs, pane, excludedView);
    return id ? sceneSelection(id) : vacantSelection(pane, state.canvasPane);
  };
  for (const pane of workbenchPanes) {
    const selection = paneSelections[pane];
    if (selection.kind === 'scene' && !state.openTabs.some(tab => tab.id === selection.tabId && tabPane(tab) === pane)) {
      const opposite = selectedScene(paneSelections[otherPane(pane)]);
      paneSelections[pane] = fallback(pane, opposite ? getSceneViewId(opposite) : undefined);
    } else if (selection.kind === 'canvas' && pane !== state.canvasPane) {
      paneSelections[pane] = fallback(pane);
    }
  }
  const primary = selectedScene(paneSelections.primary);
  const secondary = selectedScene(paneSelections.secondary);
  // Session bookmarks share one authoritative presentation, never two composers.
  if (primary && secondary && getSceneViewId(primary) === getSceneViewId(secondary)) {
    paneSelections[otherPane(state.focusedPane)] = fallback(otherPane(state.focusedPane), getSceneViewId(primary));
  }
  const sessionPane = workbenchPanes.find(pane => {
    const id = selectedScene(paneSelections[pane]);
    return id !== null && getSceneViewId(id) === 'session';
  });
  return { ...state, paneSelections, canvasPane: sessionPane ? otherPane(sessionPane) : state.canvasPane };
}

export function selectSceneInPane(state: ScenePaneState, id: SceneTabId): ScenePaneState {
  const tab = state.openTabs.find(candidate => candidate.id === id);
  if (!tab) return state;
  const pane = tabPane(tab);
  return reconcilePaneState({ ...state, focusedPane: pane,
    canvasPane: getSceneViewId(id) === 'session' ? otherPane(pane) : state.canvasPane,
    paneSelections: { ...state.paneSelections, [pane]: sceneSelection(id) } });
}

export function selectCanvasInPane(state: ScenePaneState, focus = true): ScenePaneState {
  return { ...state, focusedPane: focus ? state.canvasPane : state.focusedPane,
    paneSelections: { ...state.paneSelections, [state.canvasPane]: { kind: 'canvas' } } };
}

/** Read-only compatibility projection for scene commands and existing navigation consumers. */
export function focusedScene(state: ScenePaneState): SceneTabId | null {
  return selectedScene(state.paneSelections[state.focusedPane]);
}

export function selectedSessionTab(state: ScenePaneState): SceneTab | undefined {
  return state.openTabs.find(tab => tab.session && selectedScene(state.paneSelections[tabPane(tab)]) === tab.id);
}

export function createPaneState(openTabs: SceneTab[], activeTabId: SceneTabId | null): ScenePaneState {
  const empty: ScenePaneState = { openTabs, focusedPane: 'primary', canvasPane: 'secondary',
    paneSelections: { primary: { kind: 'empty' }, secondary: { kind: 'canvas' } } };
  return activeTabId ? selectSceneInPane(empty, activeTabId) : empty;
}
