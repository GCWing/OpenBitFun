/**
 * sceneStore — SceneBar tab lifecycle + scene navigation history.
 *
 * Tab rules:
 *   - Every explicitly opened scene stays in openTabs until the user closes it.
 *     Each session tab references one session of one device; several
 *     sessions of a workspace, and sessions of other devices, keep their own
 *     tabs. The shell-owned sessionSceneLifecycle retires a tab when its
 *     session disappears from the rendered device; tabs of other devices stay
 *     until the user closes them, and activating one renders its device.
 *   - Pinned tabs stay ahead of regular tabs; closeability is an independent
 *     scene-definition capability.
 *   - The app starts with no tabs. SceneViewport owns the tabless welcome
 *     surface until the first scene is explicitly opened.
 *
 * Navigation history (navHistory / navCursor):
 *   - Records explicit scene navigation, independently of pane command focus.
 *   - goBack / goForward select and reveal the destination's owning pane.
 *   - Both skip entries whose tabs have since been closed.
 *   - closeScene removes all history entries for the closed tab,
 *     so forward can never point to a closed tab.
 */

import { create } from 'zustand';
import {
  createPaneState,
  focusedScene,
  otherPane,
  paneFallback,
  reconcilePaneState,
  sceneSelection,
  selectedScene,
  selectedSessionTab,
  selectCanvasInPane,
  selectSceneInPane,
  tabPane,
  vacantSelection,
  workbenchPanes,
  type ScenePaneState,
  type WorkbenchPane,
} from '../workbench/scenePaneModel';
import { sessionPaneLayoutStore } from '../scenes/session/sessionPaneLayoutStore';
import { useContentResourceStore } from '../workbench/contentResourceStore';
import { requestContentClose } from '../workbench/contentResourceLifecycle';
import { requestMiniAppClose } from '../scenes/miniapps/miniAppLifecycle';
import { getActiveSurfaceId, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { getDeviceOpenIntent } from '@/infrastructure/peer-device/deviceOpenIntent';
import {
  SCENE_TAB_REGISTRY,
  getSceneDef,
  getMiniAppSceneDef,
  isSceneTabClosable,
} from '../scenes/registry';
import { getSceneNav } from '../scenes/nav-registry';
import { useNavSceneStore } from './navSceneStore';
import { useSettingsStore } from '../scenes/settings/settingsStore';
import {
  getInteractionMotion,
  type InteractionMotion,
} from '@/shared/utils/motionPreference';
import {
  getSceneViewId,
  getSessionSceneTabId,
  isSessionSceneId,
  type SceneTab,
  type SceneTabId,
  type SessionSceneTarget,
} from '../components/SceneBar/types';
import {
  abandonSettingsDraftsForContextSwitch,
  requestAllSettingsDraftsExit,
  getSettingsDraftSnapshot,
  subscribeSettingsDrafts,
} from '@/infrastructure/config/settingsDraftRegistry';

function getSceneDefOrMiniapp(id: SceneTabId) {
  const d = getSceneDef(id);
  if (d) return d;
  if (typeof id === 'string' && id.startsWith('miniapp:')) {
    const appId = (id as string).slice('miniapp:'.length);
    return getMiniAppSceneDef(appId);
  }
  return undefined;
}

function isClosableScene(id: SceneTabId): boolean {
  if (id.startsWith('content:')) return true;
  return isSceneTabClosable(getSceneDefOrMiniapp(id));
}

function buildSceneTab(id: SceneTabId, now: number): SceneTab {
  return { id, lastUsed: now };
}

function rememberSession(tab: SceneTab, session: SessionSceneTarget): SceneTab {
  return { ...tab, session, sessionHistory: [session.sessionId] };
}

/** Session tabs kept open; past this the least recently used idle ones close. */
const MAX_SESSION_TABS = 12;

/** Close the least recently used session tabs beyond the limit, never `keep` or a shown one. */
function capSessionTabs(tabs: SceneTab[], keep: SceneTabId, shown: ReadonlySet<SceneTabId>): SceneTab[] {
  const sessions = tabs.filter(tab => tab.session && !tab.pinned);
  if (sessions.length <= MAX_SESSION_TABS) return tabs;
  const closable = sessions.filter(tab => tab.id !== keep && !shown.has(tab.id) && !isHeldSessionTab(tab))
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, sessions.length - MAX_SESSION_TABS);
  const closed = new Set(closable.map(tab => tab.id));
  return tabs.filter(tab => !closed.has(tab.id));
}

/** Shell adapter: the tab owner never loads history or changes runtime state. */
export interface SessionSceneNavigation {
  current: () => SessionSceneTarget | null;
  isActive: (target: SessionSceneTarget) => boolean;
  activate: (target: SessionSceneTarget, isCurrent: () => boolean) => Promise<boolean>;
}

interface SessionSceneOpenOptions {
  /** Commit contextual content only after the owning session is presented. */
  onActivated?: () => void;
  isCurrent?: () => boolean;
  revealCanvas?: boolean;
  /** Authoritative selection updates can retain focus in the other pane. */
  focus?: boolean;
}

let sessionNavigation: SessionSceneNavigation | undefined;
let navigationRequest = 0;
let coalescedNavigation: { key: string; isCurrent: () => boolean; promise: Promise<boolean> } | undefined;
const contentClosingRequests = new Map<SceneTabId, Promise<void>>();
const contentSurfaceTabs = new Map<string, ScenePaneState>();

function resolveNavSceneId(sceneId: SceneTabId | null): SceneTabId | null {
  if (sceneId === null) return null;
  return getSceneNav(sceneId) ? sceneId : null;
}

interface SceneState extends ScenePaneState {
  /** Projection of the focused pane's scene; canvas/empty focus has no scene id. */
  activeTabId: SceneTabId | null;
  focusPane: (pane: WorkbenchPane) => void;
  selectCanvas: () => void;
  revealCanvas: () => void;
  moveScene: (id: SceneTabId, pane: WorkbenchPane, targetId?: SceneTabId, placement?: 'before' | 'after') => Promise<boolean>;
  pendingTabId: SceneTabId | null;
  /** Ordered scene destinations; changing command focus does not append history. */
  navHistory: SceneTabId[];
  /** Index of the current position in navHistory. */
  navCursor: number;
  /** Input source for the latest active-scene change. */
  navigationMotion: InteractionMotion;
  navigationSequence: number;

  openScene:    (id: SceneTabId) => void;
  openContentScene: (resourceId: string, focus?: boolean) => void;
  /** Called after authoritative session selection, replaces only its workspace slot. */
  openSessionScene: (target: SessionSceneTarget, options?: SessionSceneOpenOptions) => void;
  /** Contextual navigation may only activate the existing, unchanged session reference. */
  activateSessionScene: (target: SessionSceneTarget, options?: SessionSceneOpenOptions) => void;
  updateSessionScene: (target: SessionSceneTarget) => void;
  /** Resource reconciliation never deletes or stops the referenced sessions. */
  reconcileSessionScenes: (targets: ReadonlyMap<string, SessionSceneTarget>) => void;
  activateScene:(id: SceneTabId) => void;
  closeScene:   (id: SceneTabId) => void | Promise<void>;
  togglePinScene: (id: SceneTabId) => void;
  reorderScene: (id: SceneTabId, targetId: SceneTabId, placement?: 'before' | 'after') => void;
  goBack:       () => void;
  goForward:    () => void;
  /** Reset tabs/history when entering or exiting Peer Device Mode. */
  resetForPeerSwitch: (restoreContent?: boolean) => void;
  /**
   * Show a session of another device in the primary pane at once, before its
   * device is rendered. The tab survives the switch and session reconciliation
   * while the cross-device open that owns it runs (see `DeviceOpenIntent`), so
   * the session's loading presentation stays on screen the whole time.
   */
  holdSessionScene: (target: SessionSceneTarget) => void;
}

/** The session tab a running cross-device open shows; never reconciled away. */
function isHeldSessionTab(tab: SceneTab): boolean {
  const intent = getDeviceOpenIntent();
  return Boolean(intent?.sessionId && tab.session
    && tab.session.sessionId === intent.sessionId && tab.session.surfaceId === intent.surfaceId);
}

function buildDefaultTabs(): SceneTab[] {
  const now = Date.now();
  return SCENE_TAB_REGISTRY
    .filter(d => d.defaultOpen)
    .map(d => buildSceneTab(d.id, now));
}

/**
 * Keeps pinned tabs ahead of regular tabs without opening or protecting them.
 */
function orderPinnedTabsFirst(tabs: SceneTab[]): SceneTab[] {
  const isPinned = (tab: SceneTab) => tab.pinned ?? getSceneDefOrMiniapp(tab.id)?.pinned;
  const pinnedTabs = tabs.filter(isPinned);
  if (pinnedTabs.length === 0) return tabs;
  return [
    ...pinnedTabs,
    ...tabs.filter(tab => !isPinned(tab)),
  ];
}

/** Push id to history, trimming any forward entries. Deduplicates consecutive same id. */
function pushHistory(history: SceneTabId[], cursor: number, id: SceneTabId) {
  const trimmed = history.slice(0, cursor + 1);
  if (trimmed[trimmed.length - 1] === id) {
    return { navHistory: trimmed, navCursor: trimmed.length - 1 };
  }
  return { navHistory: [...trimmed, id], navCursor: trimmed.length };
}

/** Remove all occurrences of id from history and recalculate cursor. */
function removeFromHistory(
  history: SceneTabId[],
  cursor: number,
  removedId: SceneTabId,
  newActiveId: SceneTabId | null,
) {
  const newHistory = history.filter(h => h !== removedId);
  if (newHistory.length === 0) return { navHistory: [] as SceneTabId[], navCursor: -1 };
  if (history[cursor] !== removedId) {
    return { navHistory: newHistory, navCursor: history.slice(0, cursor + 1).filter(id => id !== removedId).length - 1 };
  }
  const idx = newActiveId ? newHistory.lastIndexOf(newActiveId) : -1;
  const newCursor = idx !== -1 ? idx : Math.min(cursor, newHistory.length - 1);
  return { navHistory: newHistory, navCursor: newCursor };
}

const initialTabs = buildDefaultTabs();
const initialActiveId = initialTabs[0]?.id ?? null;

export const useSceneStore = create<SceneState>((set, get) => ({
  ...createPaneState(initialTabs, initialActiveId),
  activeTabId: initialActiveId,
  pendingTabId: null,
  navHistory: initialActiveId ? [initialActiveId] : [],
  navCursor: initialActiveId ? 0 : -1,
  navigationMotion: 'instant',
  navigationSequence: 0,

  focusPane: pane => {
    const state = get();
    if (state.focusedPane === pane) return;
    navigationRequest++;
    set({ focusedPane: pane, activeTabId: selectedScene(state.paneSelections[pane]), pendingTabId: null });
  },
  selectCanvas: () => { void navigateWorkbench(state => ({ panes: selectCanvasInPane(state) }), { coalesceKey: 'select-canvas' }); },
  revealCanvas: () => { void navigateWorkbench(state => ({
    panes: selectCanvasInPane(state, false), reveal: [state.canvasPane],
  }), { coalesceKey: 'reveal-canvas' }); },

  moveScene: (id, pane, targetId, placement = 'before') => {
    const source = get().openTabs.find(tab => tab.id === id);
    if (!source) return Promise.resolve(false);
    return navigateWorkbench(state => {
      const tabs = state.openTabs.filter(tab => tab.id !== id);
      const index = targetId ? tabs.findIndex(tab => tab.id === targetId && tabPane(tab) === pane) : -1;
      tabs.splice(index < 0 ? tabs.length : index + (placement === 'after' ? 1 : 0), 0,
        { ...source, pane, lastUsed: Date.now() });
      const panes = selectSceneInPane({ ...state, openTabs: orderPinnedTabsFirst(tabs) }, id);
      return { panes, motion: 'instant', history: pushHistory(state.navHistory, state.navCursor, id) };
    }, { isCurrent: () => get().openTabs.find(tab => tab.id === id) === source });
  },

  openScene: (requestedId) => {
    // Keep scene destinations sent by older clients on the owning settings page.
    if (requestedId === 'ecosystem-compatibility') {
      useSettingsStore.getState().openPage('tools.external-import');
      openSceneTarget('settings');
      return;
    }
    if (requestedId === 'file-viewer') {
      useNavSceneStore.getState().openNavScene('file-viewer');
      return;
    }
    const target = requestedId === 'session' ? sessionNavigation?.current() : undefined;
    if (requestedId === 'session' && !target) return;
    openSceneTarget(target ? getSessionSceneTabId(target) : requestedId, target ?? undefined);
  },

  openSessionScene: (target, options) => openSceneTarget(getSessionSceneTabId(target), target, options),

  activateSessionScene: (target, options) => {
    const id = getSessionSceneTabId(target);
    const session = get().openTabs.find(tab => tab.id === id)?.session;
    if (!session || session.sessionId !== target.sessionId) return;
    const isCurrent = () => get().openTabs.find(tab => tab.id === id)?.session === session
      && (options?.isCurrent?.() ?? true);
    // Omit the creation target. Navigation can focus this tab, but cannot create
    // or replace it after an async activation or settings-draft exit.
    openSceneTarget(id, undefined, {
      isCurrent,
      revealCanvas: options?.revealCanvas,
      focus: options?.focus,
      onActivated: () => { if (isCurrent()) options?.onActivated?.(); },
    });
  },

  openContentScene: (resourceId, focus = true) => {
    if (!useContentResourceStore.getState().resources[resourceId]) return;
    const id: SceneTabId = `content:${resourceId}`;
    if (!get().openTabs.some(tab => tab.id === id)) {
      set(state => ({ openTabs: orderPinnedTabsFirst([...state.openTabs,
        { id, contentId: resourceId, lastUsed: Date.now() }]) }));
    }
    if (focus) get().activateScene(id);
  },

  updateSessionScene: (target) => {
    const id = getSessionSceneTabId(target);
    const state = get();
    if (!state.openTabs.some(tab => tab.id === id && tab.session !== target
      && (tab.session?.sessionId !== target.sessionId || tab.session.workspaceKey !== target.workspaceKey))) return;
    set({ openTabs: state.openTabs.map(tab => tab.id === id ? rememberSession(tab, target) : tab) });
  },

  reconcileSessionScenes: (targets) => {
    const state = get();
    const remapped = new Map<SceneTabId, SceneTabId>();
    const tabs = new Map<SceneTabId, SceneTab>();
    const activeSessionId = state.openTabs.find(tab => tab.id === state.activeTabId)?.session?.sessionId;
    for (const tab of state.openTabs) {
      if (!isSessionSceneId(tab.id)) {
        tabs.set(tab.id, tab);
        continue;
      }
      // Another device's sessions are not in this projection; its tabs stay.
      if (isHeldSessionTab(tab) || (tab.session && tab.session.surfaceId !== getActiveSurfaceId())) {
        tabs.set(tab.id, tab);
        continue;
      }
      const target = tab.session && targets.get(tab.session.sessionId);
      if (!target) continue;
      const id = getSessionSceneTabId(target);
      const history = tab.sessionHistory?.filter(sessionId => {
        const entry = targets.get(sessionId);
        return entry?.surfaceId === target.surfaceId && entry.workspaceKey === target.workspaceKey;
      });
      const reconciled = id === tab.id && target.workspaceKey === tab.session?.workspaceKey
        && history?.length === tab.sessionHistory?.length
        ? tab : { ...tab, id, session: target, sessionHistory: history };
      remapped.set(tab.id, id);
      const existing = tabs.get(id);
      if (!existing || tab.id === state.activeTabId
        || (existing.session?.sessionId !== activeSessionId && tab.lastUsed > existing.lastUsed)) {
        tabs.set(id, reconciled);
      }
    }
    const nextTabs = [...tabs.values()];
    // Another device's session is shown only while its open renders that
    // device; an open that failed or was superseded leaves the tab unselected.
    const strandedId = [state.paneSelections.primary, state.paneSelections.secondary].map(selectedScene)
      .find(id => {
        const tab = id ? tabs.get(id) : undefined;
        return Boolean(tab?.session && tab.session.surfaceId !== getActiveSurfaceId() && !isHeldSessionTab(tab));
      }) ?? null;
    if (!strandedId && nextTabs.length === state.openTabs.length && nextTabs.every((tab, i) => tab === state.openTabs[i])) return;
    const activeId = state.activeTabId && (remapped.get(state.activeTabId) ?? state.activeTabId);
    const retainedActiveId = activeId && tabs.has(activeId) && activeId !== strandedId ? activeId : null;
    const mappedHistory = state.navHistory.map(id => remapped.get(id) ?? id);
    const navHistory = mappedHistory.filter(id => tabs.has(id));
    const retiredPendingTab = state.pendingTabId !== null
      && state.openTabs.some(tab => tab.id === state.pendingTabId)
      && !remapped.has(state.pendingTabId);
    if (retiredPendingTab) navigationRequest++;
    const selection = (pane: WorkbenchPane) => {
      const id = selectedScene(state.paneSelections[pane]);
      if (!id) return state.paneSelections[pane];
      const nextId = remapped.get(id) ?? id;
      return tabs.has(nextId) && nextId !== strandedId ? sceneSelection(nextId) : vacantSelection(pane, state.canvasPane);
    };
    const panes = reconcilePaneState({ ...state, openTabs: nextTabs,
      paneSelections: { primary: selection('primary'), secondary: selection('secondary') } });
    set({ ...projectPaneState(panes),
      ...(retiredPendingTab ? { pendingTabId: null } : {}),
      navHistory,
      navCursor: retainedActiveId
        ? mappedHistory.slice(0, state.navCursor + 1).filter(id => tabs.has(id)).length - 1 : -1,
    });
    if (!retainedActiveId && state.activeTabId) {
      // Never fall back onto another device's tab: that would render the device.
      const local = nextTabs.filter(tab => !tab.session || tab.session.surfaceId === getActiveSurfaceId());
      const fallback = paneFallback(local, state.focusedPane)
        ?? [...local].sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id;
      if (fallback) get().activateScene(fallback);
    }
  },

  activateScene: (id) => {
    get().openScene(id);
  },

  togglePinScene: id => set(state => ({ openTabs: orderPinnedTabsFirst(state.openTabs.map(tab =>
    tab.id === id ? { ...tab, pinned: !(tab.pinned ?? getSceneDefOrMiniapp(id)?.pinned) } : tab)) })),

  reorderScene: (id, beforeId, placement = 'before') => set(state => {
    const moved = state.openTabs.find(tab => tab.id === id);
    if (!moved || id === beforeId || !state.openTabs.some(tab => tab.id === beforeId)) return state;
    const tabs = state.openTabs.filter(tab => tab.id !== id);
    tabs.splice(tabs.findIndex(tab => tab.id === beforeId) + (placement === 'after' ? 1 : 0), 0, moved);
    return { openTabs: orderPinnedTabsFirst(tabs) };
  }),

  closeScene: (id) => {
    const scope = getActiveSurfaceScope();
    const performClose = (applicationStopped = false) => {
      if (!scope.isCurrent()) return;
      const state = get();
      const { openTabs } = state;
      if (!openTabs.some(tab => tab.id === id) || !isClosableScene(id)) return;

      const contentId = openTabs.find(tab => tab.id === id)?.contentId;
      return navigateWorkbench(current => {
        if (!current.openTabs.some(tab => tab.id === id)) return null;
        const closingActiveSession = isSessionSceneId(id) && id === current.activeTabId;
        // A background session close must not steal the currently viewed scene.
        // Only the active session can leave the shell idle, and only when no
        // session remains on the rendered surface.
        const hasRemainingSurfaceSession = current.openTabs.some(tab => tab.id !== id
          && tab.session?.surfaceId === getActiveSurfaceId());
        const enterIdleState = closingActiveSession && !hasRemainingSurfaceSession;
        const remainingTabs = current.openTabs.filter(tab => tab.id !== id);
        const nextState = enterIdleState
          ? {
              ...current,
              openTabs: remainingTabs,
              paneSelections: {
                ...current.paneSelections,
                [current.focusedPane]: vacantSelection(current.focusedPane, current.canvasPane),
              },
            }
          : { ...current, openTabs: remainingTabs };
        let panes = reconcilePaneState(nextState);
        if (!enterIdleState && panes.paneSelections[panes.focusedPane].kind === 'empty'
          && selectedScene(panes.paneSelections[otherPane(panes.focusedPane)])) {
          panes = { ...panes, focusedPane: otherPane(panes.focusedPane) };
        }
        const history = enterIdleState
          ? { navHistory: [], navCursor: -1 }
          : removeFromHistory(current.navHistory, current.navCursor, id, focusedScene(panes));
        return { panes, reveal: id === current.activeTabId ? [panes.focusedPane] : [],
          history };
      }, { guardSettings: false, onCommitted: () => {
        if (contentId) useContentResourceStore.getState().remove(contentId);
      } }).then(activated => {
        // Stopped apps retire even if fallback activation fails or is superseded.
        if (!activated && applicationStopped && scope.isCurrent()) {
          const current = get();
          const panes = reconcilePaneState({ ...current, openTabs: current.openTabs.filter(tab => tab.id !== id) });
          // A failed fallback must not present an unactivated session.
          for (const pane of workbenchPanes) {
            if (selectedScene(current.paneSelections[pane]) === id) panes.paneSelections[pane] = vacantSelection(pane, panes.canvasPane);
          }
          const navHistory = current.navHistory.filter(tabId => tabId !== id);
          const activeTabId = focusedScene(panes);
          set({ ...projectPaneState(panes), navHistory, navCursor: activeTabId ? navHistory.lastIndexOf(activeTabId) : -1 });
        }
      });
    };

    if (id.startsWith('miniapp:')) {
      if (!get().openTabs.some(tab => tab.id === id)) return;
      return requestMiniAppClose(id.slice('miniapp:'.length), () => performClose(true));
    }
    const contentId = get().openTabs.find(tab => tab.id === id)?.contentId;
    if (contentId) {
      const pending = contentClosingRequests.get(id);
      if (pending) return pending;
      const scope = getActiveSurfaceScope();
      const request = requestContentClose(contentId).then(async approved => {
        if (approved && scope.isCurrent()) await performClose();
      }).finally(() => { if (contentClosingRequests.get(id) === request) contentClosingRequests.delete(id); });
      contentClosingRequests.set(id, request);
      return request;
    }
    if (id === 'settings') {
      const settingsWasActive = get().activeTabId === 'settings';
      const closedImmediately = requestAllSettingsDraftsExit(performClose);
      if (!closedImmediately && !settingsWasActive) get().openScene('settings');
      return;
    }
    return performClose();
  },

  goBack: () => navigateHistory(-1),
  goForward: () => navigateHistory(1),

  holdSessionScene: (target) => {
    navigationRequest++;
    const state = get();
    const id = getSessionSceneTabId(target);
    const previous = state.openTabs.find(tab => tab.id === id);
    const tab: SceneTab = {
      ...previous, id, pane: 'primary', session: target, lastUsed: Date.now(), sessionHistory: [target.sessionId],
    };
    // An open tab keeps its place; a new one goes after the shown session tab.
    const openTabs = previous
      ? state.openTabs.map(candidate => candidate.id === id ? tab : candidate)
      : insertAfterShown(state, tab);
    const panes = reconcilePaneState({ ...state, openTabs, focusedPane: 'primary',
      paneSelections: { ...state.paneSelections, primary: sceneSelection(id) } });
    set({ ...projectPaneState(panes), pendingTabId: null,
      ...pushHistory(state.navHistory, state.navCursor, id),
      navigationMotion: 'instant', navigationSequence: state.navigationSequence + 1,
    });
  },

  resetForPeerSwitch: (restoreContent = false) => {
    navigationRequest++;
    abandonSettingsDraftsForContextSwitch();
    useNavSceneStore.getState().closeNavScene();
    const state = get();
    const contentTabs = state.openTabs.filter(tab => tab.contentId);
    const origin = contentTabs[0]?.contentId
      ? useContentResourceStore.getState().resources[contentTabs[0].contentId]?.scope.surfaceId : undefined;
    if (origin) contentSurfaceTabs.set(origin, { ...projectPaneState(state), openTabs: contentTabs });
    const saved = restoreContent ? contentSurfaceTabs.get(getActiveSurfaceId()) : undefined;
    const restored = saved?.openTabs.filter(tab => tab.contentId && useContentResourceStore.getState().resources[tab.contentId])
      ?? buildDefaultTabs();
    // Session tabs of every device survive the switch; a cross-device open
    // keeps its session in front.
    const held = state.openTabs.find(isHeldSessionTab);
    const sessionTabs = state.openTabs.filter(tab => tab.session);
    const tabs = [...sessionTabs, ...restored.filter(tab => !tab.session && !sessionTabs.some(kept => kept.id === tab.id))];
    // A kept session tab is shown again only through its own activation.
    const base = saved ?? state;
    const unselected = (pane: WorkbenchPane) => {
      const id = selectedScene(base.paneSelections[pane]);
      return id && tabs.some(tab => tab.id === id && tab.session) ? vacantSelection(pane, base.canvasPane) : base.paneSelections[pane];
    };
    const paneSelections = { primary: unselected('primary'), secondary: unselected('secondary') };
    const panes = held
      ? reconcilePaneState({ ...base, openTabs: tabs, focusedPane: 'primary',
        paneSelections: { ...paneSelections, primary: sceneSelection(held.id) } })
      : saved ? reconcilePaneState({ ...saved, openTabs: tabs, paneSelections })
        : createPaneState(tabs, tabs.find(tab => !tab.session)?.id ?? null);
    const activeTabId = focusedScene(panes);
    set({ ...projectPaneState(panes), pendingTabId: null,
      navHistory: activeTabId ? [activeTabId] : [], navCursor: activeTabId ? 0 : -1,
      navigationMotion: 'instant', navigationSequence: state.navigationSequence + 1,
    });
  },
}));

/** Tests only: drop every tab, including the session tabs a switch keeps. */
export function resetSceneStoreForTest(): void {
  useSceneStore.setState({ openTabs: [], paneSelections: { primary: { kind: 'empty' }, secondary: { kind: 'canvas' } } });
  useSceneStore.getState().resetForPeerSwitch();
}

export function registerSessionSceneNavigation(adapter: SessionSceneNavigation): () => void {
  sessionNavigation = adapter;
  return () => {
    if (sessionNavigation === adapter) {
      sessionNavigation = undefined;
      navigationRequest++;
      if (useSceneStore.getState().pendingTabId !== null) useSceneStore.setState({ pendingTabId: null });
    }
  };
}

interface WorkbenchNavigationPlan {
  panes: ScenePaneState;
  reveal?: readonly WorkbenchPane[];
  history?: Pick<SceneState, 'navHistory' | 'navCursor'>;
  motion?: InteractionMotion;
}

function projectPaneState(state: ScenePaneState) {
  return { openTabs: state.openTabs, paneSelections: state.paneSelections,
    focusedPane: state.focusedPane, canvasPane: state.canvasPane, activeTabId: focusedScene(state) };
}

/** One transaction for navigation, history, moves, canvas reveal and close fallback.
 * Plan both panes before guarding drafts or activating a session. Revalidate after
 * every asynchronous boundary; no geometry or content writes precede acceptance.
 */
function navigateWorkbench(build: (state: SceneState) => WorkbenchNavigationPlan | null, options: {
  isCurrent?: () => boolean;
  onCommitted?: () => void;
  guardSettings?: boolean;
  /** Coalesce repeated idempotent UI signals (pointer and focus on one target). */
  coalesceKey?: string;
} = {}): Promise<boolean> {
  if (options.coalesceKey && coalescedNavigation?.key === options.coalesceKey && coalescedNavigation.isCurrent()) {
    return coalescedNavigation.promise;
  }
  if (options.isCurrent?.() === false || !build(useSceneStore.getState())) return Promise.resolve(false);
  const scope = getActiveSurfaceScope();
  const request = ++navigationRequest;
  const adapter = sessionNavigation;
  const ownsRequest = () => request === navigationRequest && adapter === sessionNavigation;
  const isCurrent = () => ownsRequest() && scope.isCurrent() && (options.isCurrent?.() ?? true);
  const run = (draftsApproved = false): Promise<boolean> => {
    if (!isCurrent()) return Promise.resolve(false);
    const previous = useSceneStore.getState();
    const plan = build(previous);
    if (!plan) return Promise.resolve(false);
    const hasSettings = (state: ScenePaneState) => workbenchPanes.some(pane => selectedScene(state.paneSelections[pane]) === 'settings');
    if (options.guardSettings !== false && !draftsApproved && hasSettings(previous) && !hasSettings(plan.panes)) {
      return new Promise((resolve, reject) => {
        let resumed = false;
        let stop: (() => void) | undefined;
        const proceed = () => { resumed = true; stop?.(); run(true).then(resolve, reject); };
        if (!requestAllSettingsDraftsExit(proceed)) {
          const pendingId = getSettingsDraftSnapshot().pendingNavigation?.id;
          stop = subscribeSettingsDrafts(() => {
            if (getSettingsDraftSnapshot().pendingNavigation?.id === pendingId) return;
            stop?.();
            // The registry publishes dismissal just before invoking its commit.
            queueMicrotask(() => { if (!resumed) resolve(false); });
          });
        }
      });
    }
    const session = selectedSessionTab(plan.panes);
    const unchanged = () => isCurrent() && useSceneStore.getState().openTabs === previous.openTabs
      && useSceneStore.getState().paneSelections === previous.paneSelections;
    const commit = () => {
      if (!unchanged()) return false;
      sessionPaneLayoutStore.getState().revealPanes(plan.reveal ?? [plan.panes.focusedPane]);
      useSceneStore.setState({ ...projectPaneState(plan.panes), ...plan.history, pendingTabId: null,
        navigationMotion: plan.motion ?? getInteractionMotion(), navigationSequence: previous.navigationSequence + 1 });
      options.onCommitted?.();
      return true;
    };
    if (!session?.session || !adapter || (previous.pendingTabId === null && adapter.isActive(session.session))) {
      return Promise.resolve(commit());
    }
    useSceneStore.setState({ pendingTabId: session.id });
    return adapter.activate(session.session, unchanged).then(activated => activated && commit()).finally(() => {
      if (ownsRequest() && useSceneStore.getState().pendingTabId !== null) useSceneStore.setState({ pendingTabId: null });
    });
  };
  const promise = run();
  if (options.coalesceKey) {
    const operation = { key: options.coalesceKey, isCurrent, promise };
    coalescedNavigation = operation;
    const clear = () => { if (coalescedNavigation === operation) coalescedNavigation = undefined; };
    void promise.then(clear, clear);
  }
  return promise;
}

function openSceneTarget(id: SceneTabId, session?: SessionSceneTarget, options?: SessionSceneOpenOptions): void {
  void navigateWorkbench(state => {
    const existing = state.openTabs.find(tab => tab.id === id);
    if (!existing && !session && (!getSceneDef(id) && !id.startsWith('miniapp:'))) return null;
    if (!existing && isSessionSceneId(id) && !session) return null;
    const presentation = selectedSessionTab(state);
    const created = { ...buildSceneTab(id, Date.now()),
      ...(session && presentation ? { pane: tabPane(presentation) } : {}) };
    const source = existing ?? created;
    const tab = { ...(session ? rememberSession(source, session) : source), lastUsed: Date.now() };
    const shown = new Set(workbenchPanes.map(pane => selectedScene(state.paneSelections[pane])).filter((value): value is SceneTabId => Boolean(value)));
    const tabs = existing ? state.openTabs.map(candidate => candidate.id === id ? tab : candidate)
      : session ? capSessionTabs(insertAfterShown(state, tab), id, shown) : [...state.openTabs, tab];
    let panes = selectSceneInPane({ ...state, openTabs: orderPinnedTabsFirst(tabs) }, id);
    if (options?.revealCanvas) panes = selectCanvasInPane(panes, false);
    if (options?.focus === false) panes = { ...panes, focusedPane: state.focusedPane };
    return { panes, reveal: options?.revealCanvas ? workbenchPanes : options?.focus === false ? [] : [panes.focusedPane],
      history: options?.focus === false ? undefined : pushHistory(state.navHistory, state.navCursor, id) };
  }, { isCurrent: options?.isCurrent, onCommitted: () => {
    const navSceneId = resolveNavSceneId(id);
    if (navSceneId && options?.focus !== false) useNavSceneStore.getState().openNavScene(navSceneId);
    options?.onActivated?.();
  } });
}

/** A new session tab opens next to the session tab its pane shows, else last. */
function insertAfterShown(state: ScenePaneState, tab: SceneTab): SceneTab[] {
  const shownId = selectedScene(state.paneSelections[tab.pane ?? state.focusedPane]);
  const index = shownId ? state.openTabs.findIndex(candidate => candidate.id === shownId && candidate.session) : -1;
  if (index < 0) return [...state.openTabs, tab];
  return [...state.openTabs.slice(0, index + 1), tab, ...state.openTabs.slice(index + 1)];
}

function navigateHistory(direction: -1 | 1): void {
  void navigateWorkbench(state => {
    for (let i = state.navCursor + direction; i >= 0 && i < state.navHistory.length; i += direction) {
      const id = state.navHistory[i];
      if (!state.openTabs.some(tab => tab.id === id)) continue;
      return { panes: selectSceneInPane({ ...state,
        openTabs: state.openTabs.map(tab => tab.id === id ? { ...tab, lastUsed: Date.now() } : tab) }, id),
      history: { navHistory: state.navHistory, navCursor: i } };
    }
    return null;
  });
}

/** The renderer/chrome use the scene kind; tabs/history use resource identity. */
export function selectActiveSceneId(state: SceneState): SceneTabId | null {
  return state.activeTabId ? getSceneViewId(state.activeTabId) : null;
}
/** Whether there's a valid back destination in history. */
export function selectCanGoBack(state: SceneState): boolean {
  const { navHistory, navCursor, openTabs } = state;
  for (let i = navCursor - 1; i >= 0; i--) {
    if (openTabs.some(t => t.id === navHistory[i])) return true;
  }
  return false;
}

/** Whether there's a valid forward destination in history. */
export function selectCanGoForward(state: SceneState): boolean {
  const { navHistory, navCursor, openTabs } = state;
  for (let i = navCursor + 1; i < navHistory.length; i++) {
    if (openTabs.some(t => t.id === navHistory[i])) return true;
  }
  return false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('scene:open', (e: Event) => {
    const detail = (e as CustomEvent<{ sceneId: SceneTabId }>).detail;
    const sceneId = detail?.sceneId;
    if (sceneId) {
      useSceneStore.getState().openScene(sceneId);
    }
  });
}

// ── Sync right-side scene → left-side nav ─────────────────────────────────
{
  let prev = useSceneStore.getState().activeTabId;
  useSceneStore.subscribe((state) => {
    if (state.activeTabId !== prev) {
      prev = state.activeTabId;
      const navSceneId = resolveNavSceneId(state.activeTabId);
      const navStore = useNavSceneStore.getState();
      if (navSceneId) {
        navStore.openNavScene(navSceneId);
      } else if (!(navStore.navSceneId === 'file-viewer'
        && (isSessionSceneId(state.activeTabId) || state.activeTabId === 'terminal'
          || state.activeTabId === 'shell' || state.activeTabId === 'git'
          || state.activeTabId?.startsWith('content:') || state.activeTabId === null))) {
        navStore.closeNavScene();
      }
    }
  });
}

// Resource events update tabs even when their content view has not mounted.
if (typeof window !== 'undefined') {
  const reconcileTerminal = (event: Event) => {
    const { sessionId, newName, surfaceId = getActiveSurfaceId() } = (event as CustomEvent<{ sessionId: string; newName?: string; surfaceId?: string }>).detail ?? {};
    const store = useContentResourceStore.getState();
    for (const resource of Object.values(store.resources)) {
      if (resource.scope.surfaceId !== surfaceId || resource.target.kind !== 'terminal' || resource.target.sessionId !== sessionId) continue;
      if (event.type === 'terminal-session-renamed' && newName) {
        store.update(resource.id, { content: { ...resource.content, title: newName, data: { ...resource.content.data, sessionName: newName } } });
      } else if (event.type === 'terminal-session-destroyed') {
        store.update(resource.id, { content: { ...resource.content, metadata: { ...resource.content.metadata, terminalCloseBehavior: 'detach' } } });
        if (useSceneStore.getState().openTabs.some(tab => tab.contentId === resource.id)) useSceneStore.getState().closeScene(`content:${resource.id}`);
        else store.remove(resource.id);
      }
    }
  };
  window.addEventListener('terminal-session-renamed', reconcileTerminal);
  window.addEventListener('terminal-session-destroyed', reconcileTerminal);
  if (import.meta.hot) import.meta.hot.dispose(() => {
    window.removeEventListener('terminal-session-renamed', reconcileTerminal);
    window.removeEventListener('terminal-session-destroyed', reconcileTerminal);
  });
}
