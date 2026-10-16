import { create } from 'zustand';
import { getActiveSurfaceId, surfaceScopedKey, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/** A one-sentence next-input suggestion produced after a completed turn. */
export interface PromptSuggestion {
  suggestion: string;
  sourceTurnId: string;
}

interface PromptSuggestionState {
  suggestions: Record<string, PromptSuggestion>;
  setSuggestion: (sessionId: string, suggestion: PromptSuggestion, surfaceId?: DeviceSurfaceId) => void;
  clearSuggestion: (sessionId: string, surfaceId?: DeviceSurfaceId) => void;
  removeSurfaceSuggestions: (surfaceId: DeviceSurfaceId) => void;
}

export function promptSuggestionKey(sessionId: string, surfaceId = getActiveSurfaceId()): string {
  return surfaceScopedKey(surfaceId, sessionId);
}

export const usePromptSuggestionStore = create<PromptSuggestionState>((set) => ({
  suggestions: {},
  setSuggestion: (sessionId, suggestion, surfaceId) => set((state) => ({
    suggestions: { ...state.suggestions, [promptSuggestionKey(sessionId, surfaceId)]: suggestion },
  })),
  clearSuggestion: (sessionId, surfaceId) => set((state) => {
    const key = promptSuggestionKey(sessionId, surfaceId);
    if (!(key in state.suggestions)) return state;
    const { [key]: _removed, ...suggestions } = state.suggestions;
    return { suggestions };
  }),
  removeSurfaceSuggestions: (surfaceId) => set(state => ({
    suggestions: Object.fromEntries(Object.entries(state.suggestions)
      .filter(([key]) => JSON.parse(key)[0] !== surfaceId)),
  })),
}));

export function clearPromptSuggestion(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  usePromptSuggestionStore.getState().clearSuggestion(sessionId);
}

export interface PromptSuggestionComposerState {
  editorEmpty: boolean;
  value: string;
  canCompose: boolean;
  processing: boolean;
  latestTurnId?: string;
  latestTurnStatus?: string;
}

/** A suggestion only stands in for an empty, idle composer that may submit to its session. */
export function visiblePromptSuggestion(
  stored: PromptSuggestion | null | undefined,
  composer: PromptSuggestionComposerState,
): string | null {
  if (!stored || !composer.editorEmpty || composer.value || !composer.canCompose || composer.processing) {
    return null;
  }
  if (stored.sourceTurnId !== composer.latestTurnId || composer.latestTurnStatus !== 'completed') return null;
  return stored.suggestion;
}

interface PromptSuggestionKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Tab accepts unless the child-session target switcher owns it; ArrowRight always accepts. */
export function isPromptSuggestionAcceptKey(
  event: PromptSuggestionKey,
  options: { composing: boolean; tabOwnedByTargetSwitcher: boolean },
): boolean {
  if (options.composing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === 'ArrowRight') return true;
  return event.key === 'Tab' && !options.tabOwnedByTargetSwitcher;
}
