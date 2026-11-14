import { createContext } from 'react';
import type { FlowChatReaderState } from './readerState';

export const ReaderContext = createContext<FlowChatReaderState | null>(null);
export const ItemContext = createContext('');
