import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { RIGHT_PANEL_CONFIG, STORAGE_KEYS } from '../../layout/panelConfig';

export type SessionPaneMode = 'chat-only' | 'split' | 'content-only';
export type ContentPaneSide = 'left' | 'right';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface LegacySessionPaneLayout {
  chatCollapsed: boolean;
  centerPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  rightPanelWidth: number;
}

interface SessionPaneLayoutState {
  activeKey: string;
  modes: ReadonlyMap<string, SessionPaneMode>;
  contentSide: ContentPaneSide;
  /** A physical slot preference, independent of which content occupies it. */
  preferredRightPaneWidth: number;
  activate: (surfaceId: string, sessionId: string | null) => void;
  showContent: () => void;
  hideContent: () => void;
  collapseEmptyContent: () => void;
  maximizeContent: () => void;
  restoreSplit: () => void;
  toggleContent: () => void;
  toggleMaximized: () => void;
  swapPanes: () => void;
  resizeRightPane: (width: number) => void;
  applyLegacyLayout: (layout: Partial<LegacySessionPaneLayout>) => void;
  clearSessionMemory: () => void;
}

const CONTENT_SIDE_KEY = 'openbitfun:sessionContentSide';
const scopeKey = (surfaceId: string, sessionId: string | null) => surfaceScopedKey(surfaceId, sessionId);

export const selectSessionPaneMode = (state: SessionPaneLayoutState): SessionPaneMode => (
  state.modes.get(state.activeKey) ?? 'chat-only'
);

export function projectLegacySessionPaneLayout(state: SessionPaneLayoutState): LegacySessionPaneLayout {
  const mode = selectSessionPaneMode(state);
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

/** One owner for pane modes and local layout preferences; no runtime or document state. */
export function createSessionPaneLayoutStore(storage = localPreferenceStorage()) {
  const read = (key: string) => {
    try { return storage?.getItem(key); } catch { return null; }
  };
  const write = (key: string, value: string) => {
    try { storage?.setItem(key, value); } catch { /* Layout remains usable without storage. */ }
  };
  const savedWidth = Number(read(STORAGE_KEYS.RIGHT_PANEL_LAST_WIDTH));
  const defaultWidth = typeof window !== 'undefined'
    ? Math.max(540, Math.min(800, Math.floor(window.innerWidth * 0.35)))
    : RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT;

  return createStore<SessionPaneLayoutState>((set, get) => {
    const setMode = (mode: SessionPaneMode) => set(state => {
      if (selectSessionPaneMode(state) === mode) return state;
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
      preferredRightPaneWidth: Number.isFinite(savedWidth) && savedWidth > 0
        ? normalizeWidth(savedWidth) : defaultWidth,
      activate: (surfaceId, sessionId) => {
        const activeKey = scopeKey(surfaceId, sessionId);
        if (get().activeKey !== activeKey) set({ activeKey });
      },
      showContent: () => {
        if (selectSessionPaneMode(get()) === 'chat-only') setMode('split');
      },
      hideContent: () => setMode('chat-only'),
      collapseEmptyContent: () => {
        if (selectSessionPaneMode(get()) === 'split') setMode('chat-only');
      },
      maximizeContent: () => setMode('content-only'),
      restoreSplit: () => setMode('split'),
      toggleContent: () => setMode(selectSessionPaneMode(get()) === 'chat-only' ? 'split' : 'chat-only'),
      toggleMaximized: () => setMode(selectSessionPaneMode(get()) === 'content-only' ? 'split' : 'content-only'),
      swapPanes: () => {
        if (selectSessionPaneMode(get()) !== 'split') return;
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
        let mode = selectSessionPaneMode(state);
        if (layout.rightPanelCollapsed === true) mode = 'chat-only';
        else if (layout.chatCollapsed === true || layout.centerPanelCollapsed === true) mode = 'content-only';
        else {
          if ((layout.chatCollapsed === false || layout.centerPanelCollapsed === false) && mode === 'content-only') mode = 'split';
          if (layout.rightPanelCollapsed === false && mode === 'chat-only') mode = 'split';
        }
        const width = layout.rightPanelWidth;
        const preferredRightPaneWidth = typeof width === 'number' && Number.isFinite(width) && width > 0
          ? normalizeWidth(width) : state.preferredRightPaneWidth;
        if (mode === selectSessionPaneMode(state) && preferredRightPaneWidth === state.preferredRightPaneWidth) return;
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

export const sessionPaneLayoutStore = createSessionPaneLayoutStore();
export type SessionPaneLayoutStore = ReturnType<typeof createSessionPaneLayoutStore>;

export function useSessionPaneLayout() {
  const mode = useStore(sessionPaneLayoutStore, selectSessionPaneMode);
  const contentSide = useStore(sessionPaneLayoutStore, state => state.contentSide);
  const preferredRightPaneWidth = useStore(sessionPaneLayoutStore, state => state.preferredRightPaneWidth);
  const { showContent, hideContent, toggleContent, toggleMaximized, swapPanes, resizeRightPane } = sessionPaneLayoutStore.getState();
  return { mode, contentSide, preferredRightPaneWidth, showContent, hideContent, toggleContent, toggleMaximized, swapPanes, resizeRightPane };
}
