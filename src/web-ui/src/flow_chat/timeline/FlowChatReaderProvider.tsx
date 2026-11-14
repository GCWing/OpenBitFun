import type { ReactNode } from 'react';
import type { FlowChatReaderState } from './readerState';
import { ReaderContext, ItemContext } from './readerContexts';

export function FlowChatReaderProvider({ store, children }: { store: FlowChatReaderState; children: ReactNode }) {
  return <ReaderContext.Provider value={store}>{children}</ReaderContext.Provider>;
}
export function FlowChatCardReaderProvider({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  return <ItemContext.Provider value={itemKey}>{children}</ItemContext.Provider>;
}
