import { afterEach, describe, expect, it } from 'vitest';
import { activateSurface, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import {
  clearPromptSuggestion,
  isPromptSuggestionAcceptKey,
  promptSuggestionKey,
  usePromptSuggestionStore,
  visiblePromptSuggestion,
} from './promptSuggestionStore';

const candidate = { suggestion: 'Run the tests', sourceTurnId: 't1' };
const idle = { editorEmpty: true, value: '', canCompose: true, processing: false, latestTurnId: 't1', latestTurnStatus: 'completed' };
const key = (name: string, modifiers: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
  key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
});

afterEach(() => {
  usePromptSuggestionStore.setState({ suggestions: {} });
  activateSurface(LOCAL_SURFACE_ID);
});

describe('prompt suggestion store', () => {
  it('keeps one suggestion per session and clears only the requested one', () => {
    const store = usePromptSuggestionStore.getState();
    store.setSuggestion('a', { suggestion: 'Run the tests', sourceTurnId: 't1' });
    store.setSuggestion('b', { suggestion: 'Commit it', sourceTurnId: 't2' });

    clearPromptSuggestion('a');
    clearPromptSuggestion(null);

    expect(usePromptSuggestionStore.getState().suggestions).toEqual({
      [promptSuggestionKey('b')]: { suggestion: 'Commit it', sourceTurnId: 't2' },
    });
  });

  it('isolates identical session IDs across devices and forgets only a disposed device', () => {
    const store = usePromptSuggestionStore.getState();
    store.setSuggestion('same', candidate);
    activateSurface('peer');
    expect(usePromptSuggestionStore.getState().suggestions[promptSuggestionKey('same')]).toBeUndefined();
    store.setSuggestion('same', { suggestion: 'Peer idea', sourceTurnId: 't1' });
    clearPromptSuggestion('same');
    activateSurface(LOCAL_SURFACE_ID);
    expect(usePromptSuggestionStore.getState().suggestions[promptSuggestionKey('same')]).toEqual(candidate);
    store.removeSurfaceSuggestions('peer');
    expect(Object.keys(usePromptSuggestionStore.getState().suggestions)).toHaveLength(1);
    store.removeSurfaceSuggestions(LOCAL_SURFACE_ID);
    expect(usePromptSuggestionStore.getState().suggestions).toEqual({});
  });
});

describe('visiblePromptSuggestion', () => {
  it('shows the suggestion only for an empty idle composer that can submit', () => {
    expect(visiblePromptSuggestion(candidate, idle)).toBe('Run the tests');
    expect(visiblePromptSuggestion(undefined, idle)).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, value: 'R' })).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, editorEmpty: false })).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, canCompose: false })).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, processing: true })).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, latestTurnId: 'newer' })).toBeNull();
    expect(visiblePromptSuggestion(candidate, { ...idle, latestTurnId: undefined })).toBeNull();
    for (const latestTurnStatus of ['processing', 'finishing', 'cancelled', 'error']) {
      expect(visiblePromptSuggestion(candidate, { ...idle, latestTurnStatus })).toBeNull();
    }
  });
});

describe('isPromptSuggestionAcceptKey', () => {
  const free = { composing: false, tabOwnedByTargetSwitcher: false };

  it('accepts plain Tab and ArrowRight', () => {
    expect(isPromptSuggestionAcceptKey(key('Tab'), free)).toBe(true);
    expect(isPromptSuggestionAcceptKey(key('ArrowRight'), free)).toBe(true);
    expect(isPromptSuggestionAcceptKey(key('Enter'), free)).toBe(false);
  });

  it('leaves Tab to the target switcher and ignores modified or composing keys', () => {
    const switcher = { composing: false, tabOwnedByTargetSwitcher: true };
    expect(isPromptSuggestionAcceptKey(key('Tab'), switcher)).toBe(false);
    expect(isPromptSuggestionAcceptKey(key('ArrowRight'), switcher)).toBe(true);
    expect(isPromptSuggestionAcceptKey(key('Tab', { shiftKey: true }), free)).toBe(false);
    expect(isPromptSuggestionAcceptKey(key('ArrowRight', { metaKey: true }), free)).toBe(false);
    expect(isPromptSuggestionAcceptKey(key('Tab'), { ...free, composing: true })).toBe(false);
  });
});
