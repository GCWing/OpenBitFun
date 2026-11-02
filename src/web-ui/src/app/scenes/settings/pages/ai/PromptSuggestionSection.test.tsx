// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PromptSuggestionSection from './PromptSuggestionSection';
import { promptSuggestionKey, usePromptSuggestionStore } from '@/flow_chat/store/promptSuggestionStore';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  aiExperienceConfigService: {
    getCachedSettings: () => null,
    getSettingsAsync: mocks.get,
    saveSettings: mocks.save,
    addChangeListener: () => () => undefined,
  },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error, success: mocks.success }) }));

let container: HTMLDivElement;
let root: Root;
const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ enable_prompt_suggestion: true });
  mocks.save.mockResolvedValue(undefined);
  usePromptSuggestionStore.setState({ suggestions: {}, enabledBySurface: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePromptSuggestionStore.setState({ suggestions: {}, enabledBySurface: {} });
});

describe('Prompt suggestion settings', () => {
  it('keeps older hosts without the optional setting explicitly unsupported', async () => {
    mocks.get.mockResolvedValue({});
    await act(async () => root.render(<PromptSuggestionSection />));
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain('promptSuggestion.unsupported');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('saves only the prompt suggestion field and keeps the previous value on failure', async () => {
    const candidate = { suggestion: 'Run the tests', sourceTurnId: 't1' };
    usePromptSuggestionStore.getState().setSuggestion('session', candidate);
    await act(async () => root.render(<PromptSuggestionSection />));
    expect(toggle().checked).toBe(true);
    mocks.save.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(true);
    expect(mocks.error).toHaveBeenCalledWith('promptSuggestion.messages.saveFailed');
    expect(usePromptSuggestionStore.getState().suggestions[promptSuggestionKey('session')]).toEqual(candidate);
    await act(async () => toggle().click());
    expect(mocks.save).toHaveBeenLastCalledWith({ enable_prompt_suggestion: false });
    expect(toggle().checked).toBe(false);
    expect(usePromptSuggestionStore.getState().suggestions).toEqual({});
    usePromptSuggestionStore.getState().setSuggestion('session', candidate);
    expect(usePromptSuggestionStore.getState().suggestions).toEqual({});
    expect(mocks.success).toHaveBeenCalledWith('promptSuggestion.messages.saveSuccess');
  });

  it('locks an unread configuration and retries without writing defaults', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => root.render(<PromptSuggestionSection />));
    expect(toggle()).toBeNull();
    expect(container.textContent).toContain('promptSuggestion.loadFailedLocked');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(toggle().disabled).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
