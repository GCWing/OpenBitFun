import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { RIGHT_PANEL_CONFIG, STORAGE_KEYS } from '../layout/panelConfig';
import type { WorkbenchPane } from './scenePaneModel';

export type SessionPaneMode = 'chat-only' | 'split' | 'content-only';
export type ContentPaneSide = 'left' | 'right';
export type SessionPaneDisplayMode = 'split' | 'overlay';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface LegacySessionPaneLayout {
  chatCollapsed: boolean;
  centerPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelWidth: number;
}

interface WorkbenchPaneLayoutState {
  activeKey: string;
  modes: ReadonlyMap<string, SessionPaneMode>;
  contentSide: ContentPaneSide;
  displayMode: SessionPaneDisplayMode;
  preferredOverlayWidth: number;
  setDisplayMode: (mode: SessionPaneDisplayMode) => void;
  resizeOverlay: (width: number) => void;
  /** A physical slot preference, independent of which content occupies it. */
  preferredRightPaneWidth: number;
  activate: (surfaceId: string, sessionId: string | null) => void;
  showContent: () => void;
  hideContent: () => void;
  collapseEmptyContent: () => void;
  maximizeContent: () => void;
  restoreSplit: () => void;
  revealPanes: (panes: readonly WorkbenchPane[]) => void;
  toggleContent: () => void;
  toggleMaximized: () => void;
  swapPanes: () => void;
  resizeRightPane: (width: number) => void;
  applyLegacyLayout: (layout: Partial<LegacySessionPaneLayout>) => void;
  clearSessionMemory: () => void;
}

const CONTENT_SIDE_KEY = 'openbitfun:sessionContentSide';
const DISPLAY_MODE_KEY = 'openbitfun:sessionPaneDisplayMode';
const OVERLAY_WIDTH_KEY = 'openbitfun:sessionOverlayWidth';
const scopeKey = (surfaceId: string, sessionId: string | null) => surfaceScopedKey(surfaceId, sessionId);

export const selectWorkbenchPaneMode = (state: WorkbenchPaneLayoutState): SessionPaneMode => (
  state.modes.get(state.activeKey) ?? 'chat-only'
);

export function projectLegacySessionPaneLayout(state: WorkbenchPaneLayoutState): LegacySessionPaneLayout {
  const mode = selectWorkbenchPaneMode(state);
  return {
    chatCollapsed: mode === 'content-only',
    centerPanelCollapsed: false,
    rightPanelCollapsed: mode === 'chat-only',
    rightPanelWidth: state.preferredRightPaneWidth,
  };
}

function localPreferenceStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Workbench geometry is device-local, independent of session content snapshots. */
export function createWorkbenchPaneLayoutStore(storage = localPreferenceStorage()) {
  const read = (key: string) => {
    try { return storage?.getItem(key); } catch { return null; }
  };
  const write = (key: string, value: string) => {
    try { storage?.setItem(key, value); } catch { /* Layout remains usable without storage. */ }
  };
  const savedWidth = Number(read(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH));
  const savedOverlayWidth = Number(read(OVERLAY_WIDTH_KEY));
  const defaultWidth = typeof window !== 'undefined'
    ? Math.max(540, Math.min(800, Math.floor(window.innerWidth * 0.35)))
    : RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT;

  return createStore<WorkbenchPaneLayoutState>((set, get) => {
    const setMode = (mode: SessionPaneMode) => set(state => {
      if (selectWorkbenchPaneMode(state) === mode) return state;
      const modes = new Map(state.modes);
      modes.set(state.activeKey, mode);
      return { modes };
    });
    const normalizeWidth = (width: number) => Math.min(
      RIGHT_PANEL_CONFIG.MAX_WIDTH, Math.max(RIGHT_PANEL_CONFIG.COMPACT_WIDTH, width),
    );
    return {
      activeKey: scopeKey('local', null),
      modes: new Map(),
      contentSide: read(CONTENT_SIDE_KEY) === 'left' ? 'left' : 'right',
      displayMode: read(DISPLAY_MODE_KEY) === 'overlay' ? 'overlay' : 'split',
      preferredOverlayWidth: Number.isFinite(savedOverlayWidth) && savedOverlayWidth > 0
        ? normalizeWidth(savedOverlayWidth) : defaultWidth,
      setDisplayMode: displayMode => {
        if ((displayMode !== 'split' && displayMode !== 'overlay') || get().displayMode === displayMode) return;
        write(DISPLAY_MODE_KEY, displayMode);
        set({ displayMode });
      },
      resizeOverlay: width => {
        if (!Number.isFinite(width) || width <= 0) return;
        const preferredOverlayWidth = normalizeWidth(width);
        if (get().preferredOverlayWidth === preferredOverlayWidth) return;
        write(OVERLAY_WIDTH_KEY, String(preferredOverlayWidth));
        set({ preferredOverlayWidth });
      },
      preferredRightPaneWidth: Number.isFinite(savedWidth) && savedWidth > 0
        ? normalizeWidth(savedWidth) : defaultWidth,
      activate: (surfaceId, sessionId) => {
        const activeKey = scopeKey(surfaceId, null);
        if (get().activeKey === activeKey) return;
        // Read a legacy in-memory session entry once; subsequent session changes
        // cannot hide another page occupying the workbench's secondary pane.
        const state = get();
        const legacy = state.modes.get(scopeKey(surfaceId, sessionId));
        const modes = !state.modes.has(activeKey) && legacy
          ? new Map(state.modes).set(activeKey, legacy) : state.modes;
        set({ activeKey, modes });
      },
      showContent: () => {
        if (selectWorkbenchPaneMode(get()) === 'chat-only') setMode('split');
      },
      hideContent: () => setMode('chat-only'),
      collapseEmptyContent: () => {
        if (selectWorkbenchPaneMode(get()) === 'split') setMode('chat-only');
      },
      maximizeContent: () => setMode('content-only'),
      restoreSplit: () => setMode('split'),
      revealPanes: panes => {
        const mode = selectWorkbenchPaneMode(get());
        if ((panes.includes('primary') && mode === 'content-only')
          || (panes.includes('secondary') && mode === 'chat-only')) setMode('split');
      },
      toggleContent: () => setMode(selectWorkbenchPaneMode(get()) === 'chat-only' ? 'split' : 'chat-only'),
      toggleMaximized: () => setMode(selectWorkbenchPaneMode(get()) === 'content-only' ? 'split' : 'content-only'),
      swapPanes: () => {
        if (selectWorkbenchPaneMode(get()) !== 'split') return;
        const contentSide = get().contentSide === 'right' ? 'left' : 'right';
        write(CONTENT_SIDE_KEY, contentSide);
        set({ contentSide });
      },
      resizeRightPane: width => {
        if (!Number.isFinite(width) || width <= 0) return;
        const preferredRightPaneWidth = normalizeWidth(width);
        if (get().preferredRightPaneWidth === preferredRightPaneWidth) return;
        write(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH, String(preferredRightPaneWidth));
        set({ preferredRightPaneWidth });
      },
      applyLegacyLayout: layout => {
        const state = get();
        let mode = selectWorkbenchPaneMode(state);
        if (layout.rightPanelCollapsed === true) mode = 'chat-only';
        else if (layout.chatCollapsed === true || layout.centerPanelCollapsed === true) mode = 'content-only';
        else {
          if ((layout.chatCollapsed === false || layout.centerPanelCollapsed === false) && mode === 'content-only') mode = 'split';
          if (layout.rightPanelCollapsed === false && mode === 'chat-only') mode = 'split';
        }
        const width = layout.rightPanelWidth;
        const preferredRightPaneWidth = typeof width === 'number' && Number.isFinite(width) && width > 0
          ? normalizeWidth(width) : state.preferredRightPaneWidth;
        if (mode === selectWorkbenchPaneMode(state) && preferredRightPaneWidth === state.preferredRightPaneWidth) return;
        const modes = new Map(state.modes);
        modes.set(state.activeKey, mode);
        if (preferredRightPaneWidth !== state.preferredRightPaneWidth) {
          write(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH, String(preferredRightPaneWidth));
        }
        set({ modes, preferredRightPaneWidth });
      },
      clearSessionMemory: () => set({ activeKey: scopeKey('local', null), modes: new Map() }),
    };
  });
}

export const workbenchPaneLayoutStore = createWorkbenchPaneLayoutStore();
export type WorkbenchPaneLayoutStore = ReturnType<typeof createWorkbenchPaneLayoutStore>;

export function useWorkbenchPaneLayout() {
  const mode = useStore(workbenchPaneLayoutStore, selectWorkbenchPaneMode);
  const contentSide = useStore(workbenchPaneLayoutStore, state => state.contentSide);
  const preferredRightPaneWidth = useStore(workbenchPaneLayoutStore, state => state.preferredRightPaneWidth);
  const displayMode = useStore(workbenchPaneLayoutStore, state => state.displayMode);
  const preferredOverlayWidth = useStore(workbenchPaneLayoutStore, state => state.preferredOverlayWidth);
  const { showContent, hideContent, toggleContent, toggleMaximized, swapPanes, resizeRightPane, resizeOverlay } = workbenchPaneLayoutStore.getState();
  return { mode, contentSide, displayMode, preferredOverlayWidth, preferredRightPaneWidth,
    showContent, hideContent, toggleContent, toggleMaximized, swapPanes, resizeRightPane, resizeOverlay };
}
