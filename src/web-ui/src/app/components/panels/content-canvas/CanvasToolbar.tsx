import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorGroupId } from './types';
import { CanvasStoreModeContext } from './stores';

type ToolbarEntry = { owner: symbol; content: React.ReactNode };
type ToolbarRegistry = Partial<Record<EditorGroupId, ToolbarEntry>>;
const RegistrationContext = createContext<{
  register: (id: EditorGroupId, owner: symbol, content: React.ReactNode) => void;
  remove: (id: EditorGroupId, owner: symbol) => void;
} | null>(null);
const ContentContext = createContext<ToolbarRegistry>({});

/** A host chooses toolbar placement; canvas groups continue to own tab behavior. */
export function CanvasToolbarProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<ToolbarRegistry>({});
  const register = useCallback((id: EditorGroupId, owner: symbol, content: React.ReactNode) => {
    setEntries(current => current[id]?.owner === owner && current[id]?.content === content
      ? current : { ...current, [id]: { owner, content } });
  }, []);
  const remove = useCallback((id: EditorGroupId, owner: symbol) => {
    setEntries(current => {
      if (current[id]?.owner !== owner) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const registration = useMemo(() => ({ register, remove }), [register, remove]);
  return <RegistrationContext.Provider value={registration}>
    <ContentContext.Provider value={entries}>{children}</ContentContext.Provider>
  </RegistrationContext.Provider>;
}

export function useExternalCanvasToolbar(enabled: boolean) {
  const registration = useContext(RegistrationContext);
  return enabled && registration !== null;
}

export function CanvasToolbarContribution({ groupId, children }: {
  groupId: EditorGroupId; children: React.ReactNode;
}) {
  const registration = useContext(RegistrationContext);
  const mode = useContext(CanvasStoreModeContext);
  const owner = useRef(Symbol('canvas-toolbar'));
  const content = useMemo(() => (
    <CanvasStoreModeContext.Provider value={mode}>{children}</CanvasStoreModeContext.Provider>
  ), [children, mode]);
  useLayoutEffect(() => {
    registration?.register(groupId, owner.current, content);
  }, [content, groupId, registration]);
  useLayoutEffect(() => () => registration?.remove(groupId, owner.current), [groupId, registration]);
  return registration ? null : <>{children}</>;
}

export function CanvasToolbarHost() {
  const entries = useContext(ContentContext);
  return <>{(['primary', 'secondary', 'tertiary'] as const).map(groupId => entries[groupId] && (
    <div key={groupId} className="openbitfun-workbench-layout__tab-group" data-canvas-toolbar-group={groupId}>
      {entries[groupId].content}
    </div>
  ))}</>;
}
