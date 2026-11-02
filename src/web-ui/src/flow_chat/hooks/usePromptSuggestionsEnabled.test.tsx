// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { usePromptSuggestionsEnabled } from './usePromptSuggestionsEnabled';
import { promptSuggestionKey, usePromptSuggestionStore, visiblePromptSuggestion } from '../store/promptSuggestionStore';

const service = vi.hoisted(() => ({
  cached: vi.fn(), read: vi.fn(), listeners: new Set<(value: unknown) => void>(),
}));
vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({ aiExperienceConfigService: {
  getCachedSettings: service.cached,
  getSettingsAsync: service.read,
  addChangeListener: (listener: (value: unknown) => void) => {
    service.listeners.add(listener);
    return () => service.listeners.delete(listener);
  },
} }));

const candidate = { suggestion: 'Run the tests', sourceTurnId: 't1' };
function Composer() {
  const enabled = usePromptSuggestionsEnabled();
  const stored = usePromptSuggestionStore(state => state.suggestions[promptSuggestionKey('session')]);
  return <div data-enabled={enabled}>{visiblePromptSuggestion(stored, {
    enabled, editorEmpty: true, value: '', canCompose: true, processing: false,
    latestTurnId: 't1', latestTurnStatus: 'completed',
  })}</div>;
}

describe('prompt suggestion preference', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    activateSurface('local');
    service.cached.mockReset().mockReturnValue({ enable_prompt_suggestion: true });
    service.read.mockReset().mockResolvedValue({ enable_prompt_suggestion: true });
    service.listeners.clear();
    usePromptSuggestionStore.setState({ suggestions: {}, enabledBySurface: {} });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    activateSurface('local');
    usePromptSuggestionStore.setState({ suggestions: {}, enabledBySurface: {} });
  });

  it('immediately hides and clears hints, rejects late events, and enables only new hints', async () => {
    usePromptSuggestionStore.getState().setSuggestion('session', candidate);
    await act(async () => root.render(<Composer />));
    expect(container.textContent).toBe('Run the tests');
    act(() => service.listeners.forEach(listener => listener({ enable_prompt_suggestion: false })));
    expect(container.textContent).toBe('');
    act(() => usePromptSuggestionStore.getState().setSuggestion('session', candidate));
    act(() => service.listeners.forEach(listener => listener({ enable_prompt_suggestion: true })));
    expect(container.textContent).toBe('');
    act(() => usePromptSuggestionStore.getState().setSuggestion('session', candidate));
    expect(container.textContent).toBe('Run the tests');
  });

  it('does not show suggestions before settings load or for an older unsupported host', async () => {
    service.cached.mockReturnValue(null);
    let resolve!: (value: unknown) => void;
    service.read.mockReturnValue(new Promise(done => { resolve = done; }));
    usePromptSuggestionStore.getState().setSuggestion('session', candidate);
    act(() => root.render(<Composer />));
    expect(container.textContent).toBe('');
    await act(async () => resolve({}));
    expect(container.firstElementChild?.getAttribute('data-enabled')).toBe('false');
    expect(usePromptSuggestionStore.getState().suggestions).toEqual({});
  });

  it('does not apply one host preference or late read to another host', async () => {
    let resolveLocal!: (value: unknown) => void;
    let resolvePeer!: (value: unknown) => void;
    service.read.mockReturnValueOnce(new Promise(done => { resolveLocal = done; }))
      .mockReturnValueOnce(new Promise(done => { resolvePeer = done; }));
    usePromptSuggestionStore.getState().setSuggestion('session', candidate, 'local');
    usePromptSuggestionStore.getState().setSuggestion('session', candidate, 'peer');
    act(() => root.render(<Composer />));
    expect(container.textContent).toBe('Run the tests');
    act(() => activateSurface('peer'));
    expect(container.textContent).toBe('');
    await act(async () => resolveLocal({ enable_prompt_suggestion: false }));
    expect(usePromptSuggestionStore.getState().enabledBySurface.peer).toBeUndefined();
    await act(async () => resolvePeer({ enable_prompt_suggestion: false }));
    expect(usePromptSuggestionStore.getState().suggestions[promptSuggestionKey('session', 'peer')]).toBeUndefined();
    expect(usePromptSuggestionStore.getState().suggestions[promptSuggestionKey('session', 'local')]).toEqual(candidate);
  });
});
