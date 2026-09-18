import { create } from 'zustand';
import type { SessionSceneTarget } from '../components/SceneBar/types';
import type { FlowChatFocusItemRequest } from '@/flow_chat/events/flowchatNavigation';

export interface DockConversation extends SessionSceneTarget {
  kind: 'control' | 'session' | 'miniapp';
  appId?: string;
  claimToken?: string;
}

export const dockConversationKey = (ref: Pick<DockConversation, 'surfaceId' | 'sessionId'>) =>
  JSON.stringify([ref.surfaceId, ref.sessionId]);

export const miniAppDockKey = (surfaceId: string, appId: string) => JSON.stringify([surfaceId, appId]);

interface ConversationDockState {
  entries: DockConversation[];
  activeBySurface: Record<string, string>;
  open: boolean;
  drafts: Record<string, { id: number; text: string }>;
  focusRequests: Record<string, FlowChatFocusItemRequest>;
  hiddenMiniApps: Record<string, boolean>;
  requestFocus: (key: string, request: FlowChatFocusItemRequest) => void;
  consumeFocus: (key: string, request: FlowChatFocusItemRequest) => void;
  setDraft: (key: string, text: string) => void;
  consumeDraft: (key: string, id: number) => void;
  setOpen: (open: boolean) => void;
  add: (entry: DockConversation, focus?: boolean) => void;
  select: (key: string) => void;
  remove: (key: string) => void;
  hide: (key: string) => void;
  closeMiniApp: (surfaceId: string, appId: string) => void;
  reorder: (source: string, target: string) => void;
}

/** Presentation references only. Closing a view never mutates its Agent session. */
export const useConversationDockStore = create<ConversationDockState>((set, get) => ({
  entries: [], activeBySurface: {}, open: false, drafts: {}, focusRequests: {}, hiddenMiniApps: {},
  requestFocus: (key, request) => set(state => ({ focusRequests: { ...state.focusRequests, [key]: request } })),
  consumeFocus: (key, request) => set(state => {
    if (state.focusRequests[key] !== request) return state;
    const focusRequests = { ...state.focusRequests }; delete focusRequests[key]; return { focusRequests };
  }),
  setDraft: (key, text) => set(state => ({ drafts: { ...state.drafts, [key]: { id: (state.drafts[key]?.id ?? 0) + 1, text } } })),
  consumeDraft: (key, id) => set(state => {
    if (state.drafts[key]?.id !== id) return state;
    const drafts = { ...state.drafts }; delete drafts[key]; return { drafts };
  }),
  setOpen: open => set({ open }),
  add: (entry, focus = true) => set(state => {
    const key = dockConversationKey(entry);
    const matchesEntry = (item: DockConversation) => entry.kind === 'control'
      ? item.kind === 'control' && item.surfaceId === entry.surfaceId
      : dockConversationKey(item) === key || (entry.kind === 'miniapp'
        && item.kind === 'miniapp' && item.surfaceId === entry.surfaceId && item.appId === entry.appId);
    const existing = state.entries.findIndex(matchesEntry);
    const entries = state.entries.filter((item, index) => index === existing || !matchesEntry(item));
    const replacesActive = state.entries.some(item => matchesEntry(item)
      && state.activeBySurface[entry.surfaceId] === dockConversationKey(item));
    if (existing < 0) entries.push(entry);
    else entries[existing] = entry;
    const hiddenMiniApps = { ...state.hiddenMiniApps };
    if (entry.kind === 'miniapp' && focus) delete hiddenMiniApps[miniAppDockKey(entry.surfaceId, entry.appId!)];
    return { entries, hiddenMiniApps, activeBySurface: focus || replacesActive || !state.activeBySurface[entry.surfaceId]
      ? { ...state.activeBySurface, [entry.surfaceId]: key } : state.activeBySurface };
  }),
  select: key => {
    const entry = get().entries.find(item => dockConversationKey(item) === key);
    if (entry) set(state => ({ activeBySurface: { ...state.activeBySurface, [entry.surfaceId]: key } }));
  },
  remove: key => set(state => {
    const entry = state.entries.find(item => dockConversationKey(item) === key);
    if (!entry || entry.kind === 'control') return state;
    const entries = state.entries.filter(item => dockConversationKey(item) !== key);
    const fallback = entries.find(item => item.surfaceId === entry.surfaceId && item.kind === 'control')
      ?? entries.find(item => item.surfaceId === entry.surfaceId);
    const activeBySurface = { ...state.activeBySurface };
    if (activeBySurface[entry.surfaceId] === key) {
      if (fallback) activeBySurface[entry.surfaceId] = dockConversationKey(fallback);
      else delete activeBySurface[entry.surfaceId];
    }
    return { entries, activeBySurface };
  }),
  hide: key => {
    const entry = get().entries.find(item => dockConversationKey(item) === key);
    if (entry?.kind === 'miniapp') set(state => ({
      hiddenMiniApps: { ...state.hiddenMiniApps, [miniAppDockKey(entry.surfaceId, entry.appId!)]: true },
    }));
    get().remove(key);
  },
  closeMiniApp: (surfaceId, appId) => {
    for (const entry of get().entries) {
      if (entry.surfaceId === surfaceId && entry.kind === 'miniapp' && entry.appId === appId) get().remove(dockConversationKey(entry));
    }
    set(state => {
      const hiddenMiniApps = { ...state.hiddenMiniApps };
      delete hiddenMiniApps[miniAppDockKey(surfaceId, appId)];
      return { hiddenMiniApps };
    });
  },
  reorder: (source, target) => set(state => {
    const entry = state.entries.find(item => dockConversationKey(item) === source);
    const destination = state.entries.find(item => dockConversationKey(item) === target);
    if (!entry || !destination || entry.kind === 'control' || destination.kind === 'control'
      || entry.surfaceId !== destination.surfaceId) return state;
    const entries = state.entries.filter(item => item !== entry);
    entries.splice(entries.indexOf(destination), 0, entry);
    return { entries };
  }),
}));
