import { tokens } from '@openbitfun/design-tokens';
import { createStore } from 'zustand/vanilla';

export const DEFAULT_FLOW_CHAT_WIDTH = Number.parseFloat(String(tokens['control.flowChat.transcriptMaxWidth']));
export const MIN_FLOW_CHAT_WIDTH = Math.round(DEFAULT_FLOW_CHAT_WIDTH * 2 / 3);
export const FLOW_CHAT_WIDTH_STORAGE_KEY = 'openbitfun:appearance:flowChatWidth';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function localStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Controller-local appearance preference, shared by all conversation panes.
 * The saved width is never reduced by a narrow pane or a remote session.
 */
export function createFlowChatWidthStore(storage = localStorage()) {
  let saved = Number.NaN;
  try {
    const value = storage?.getItem(FLOW_CHAT_WIDTH_STORAGE_KEY);
    if (value?.trim()) saved = Number(value);
  } catch { /* Appearance remains usable when storage is unavailable. */ }

  return createStore<{
    preferredWidth: number;
    setPreferredWidth: (width: number) => void;
  }>((set, get) => ({
    preferredWidth: Number.isFinite(saved) && saved >= MIN_FLOW_CHAT_WIDTH
      ? Math.round(saved) : DEFAULT_FLOW_CHAT_WIDTH,
    setPreferredWidth: width => {
      if (!Number.isFinite(width)) return;
      const preferredWidth = Math.max(MIN_FLOW_CHAT_WIDTH, Math.round(width));
      if (get().preferredWidth === preferredWidth) return;
      try { storage?.setItem(FLOW_CHAT_WIDTH_STORAGE_KEY, String(preferredWidth)); }
      catch { /* Keep the in-memory preference if persistence is unavailable. */ }
      set({ preferredWidth });
    },
  }));
}

export const flowChatWidthStore = createFlowChatWidthStore();
