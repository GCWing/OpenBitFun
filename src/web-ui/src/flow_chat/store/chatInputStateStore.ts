/** ChatInput layout measurements shared with the transcript viewport. */

import { create, useStore } from 'zustand';
import { createContext, useContext } from 'react';

interface ChatInputStateStore {
  /** Measured height of the ChatInput container in pixels (0 if unknown) */
  inputHeight: number;
  setInputHeight: (height: number) => void;
}

export const createChatInputStateStore = () => create<ChatInputStateStore>((set) => ({
  inputHeight: 0,
  setInputHeight: (inputHeight) => set({ inputHeight }),
}));

const defaultChatInputStateStore = createChatInputStateStore();
export const ChatInputStateStoreContext = createContext<ReturnType<typeof createChatInputStateStore> | null>(null);
export const useChatInputState = Object.assign(
  function useScopedChatInputState<T>(selector: (state: ChatInputStateStore) => T): T {
    return useStore(useContext(ChatInputStateStoreContext) ?? defaultChatInputStateStore, selector);
  },
  defaultChatInputStateStore,
);

