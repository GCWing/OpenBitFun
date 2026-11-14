import { createContext, useContext, type ReactNode } from 'react';
import type { EditorGroupId } from './types';

type ToolbarEntry = { owner: symbol; content: ReactNode };
export type ToolbarRegistry = Partial<Record<EditorGroupId, ToolbarEntry>>;
export const RegistrationContext = createContext<{
  register: (id: EditorGroupId, owner: symbol, content: ReactNode) => void;
  remove: (id: EditorGroupId, owner: symbol) => void;
} | null>(null);
export const ContentContext = createContext<ToolbarRegistry>({});

export function useExternalCanvasToolbar(enabled: boolean) {
  const registration = useContext(RegistrationContext);
  return enabled && registration !== null;
}
