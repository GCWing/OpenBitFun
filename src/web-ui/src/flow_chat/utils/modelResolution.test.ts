/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '@/infrastructure/api/service-api/AIApi';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { setRecentReasoningPreset } from './reasoningPresets';
import {
  getModelMaxTokens,
  resolveModelReference,
  resolveModelSelection,
  resolveReasoningPresetForSessionCreation,
} from './modelResolution';
import type { AIModelConfig } from '@/infrastructure/config/types';

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({
  aiApi: { getModelCatalog: vi.fn() },
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { getConfigs: vi.fn() },
}));

describe('configured model identity', () => {
  const first: AIModelConfig = {
    id: 'model-first', name: 'MOCK-8000', model_name: 'asdf',
    provider: 'openai', base_url: 'https://example.test', enabled: true,
    category: 'general_chat', capabilities: ['text_chat'], context_window: 32000,
    metadata: { provider_instance_id: 'account-1' },
  };
  const selected: AIModelConfig = {
    ...first, id: 'asdf', name: 'MOCK-8000-2', context_window: 64000,
    metadata: { provider_instance_id: 'account-2' },
  };
  const models = [first, selected];

  it.each([models, [selected, first]])('preserves the selected account regardless of catalog order: %j', (...ordered) => {
    const result = resolveModelSelection({ models: ordered, sessionModelId: 'asdf' });
    expect(result).toMatchObject({
      model: selected, selectorId: 'asdf', concreteModelId: 'asdf',
      source: 'session', recovered: false,
    });
  });

  it('does not match a display name even when it equals another config ID', () => {
    expect(resolveModelReference([{ ...first, name: 'asdf' }, selected], 'asdf')).toBe(selected);
    expect(resolveModelReference(models, 'MOCK-8000-2')).toBeNull();
    expect(resolveModelReference([first], 'asdf')).toBeNull();
  });

  it.each(['primary', 'fast'])('resolves the %s alias through the exact configured ID', selector => {
    expect(resolveModelSelection({
      models, sessionModelId: selector, defaultModels: { primary: 'asdf', fast: 'asdf' },
    })).toMatchObject({ model: selected, selectorId: selector, concreteModelId: 'asdf' });
  });

  it('keeps Fast fallback to the configured Primary ID', () => {
    expect(resolveModelReference(models, 'fast', { fast: 'missing', primary: 'asdf' })).toBe(selected);
  });

  it.each(['missing', 'MOCK-8000-2'])('marks an unavailable pinned reference %s without choosing another account', sessionModelId => {
    expect(resolveModelSelection({ models, sessionModelId, defaultModels: { primary: 'model-first' } }))
      .toEqual({ model: null, source: 'session', recovered: true });
  });

  it('rejects disabled, missing-ID and duplicate-ID entries', () => {
    expect(resolveModelReference([first, { ...selected, enabled: false }], 'asdf')).toBeNull();
    expect(resolveModelSelection({ models: [{ ...selected, id: undefined }] }).model).toBeNull();
    expect(resolveModelReference([selected, { ...first, id: 'asdf' }], 'asdf')).toBeNull();
  });

  it('uses the selected account context window', async () => {
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.models': models, 'ai.default_models': { primary: 'model-first' },
    });
    await expect(getModelMaxTokens('asdf')).resolves.toBe(64000);
  });
});

describe('reasoning preset session creation resolution', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    });
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    vi.mocked(aiApi.getModelCatalog).mockResolvedValue({
      version: 1,
      default_models: { primary: 'model-primary', fast: 'model-fast' },
      models: [
        {
          id: 'model-primary',
          name: 'Primary',
          provider: 'responses',
          base_url: 'https://example.test',
          model_name: 'gpt-primary',
          enabled: true,
          capabilities: ['text_chat'],
          reasoning: {
            status: 'known',
            presets: [{
              id: 'high',
              label: 'High',
              order: 10,
              source: 'models_dev',
              actions: [{ type: 'effort', value: 'high' }],
            }],
          },
        },
        {
          id: 'model-fast',
          name: 'Fast',
          provider: 'responses',
          base_url: 'https://example.test',
          model_name: 'gpt-fast',
          enabled: true,
          capabilities: ['text_chat'],
          reasoning: { status: 'unsupported', presets: [] },
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves Primary through the concrete primary model and restores its recent preset', async () => {
    setRecentReasoningPreset('model-primary', 'high');
    await expect(resolveReasoningPresetForSessionCreation('primary')).resolves.toBe('high');
  });

  it('uses the configured mode model for a new session without an explicit model', async () => {
    vi.mocked(configManager.getConfigs).mockResolvedValue({
      'ai.agent_model_defaults': { mode: 'primary' },
    });
    setRecentReasoningPreset('model-primary', 'high');

    await expect(resolveReasoningPresetForSessionCreation()).resolves.toBe('high');
  });

  it('falls back to Primary when a stale selector is restored', async () => {
    setRecentReasoningPreset('model-primary', 'high');
    await expect(resolveReasoningPresetForSessionCreation('removed-model')).resolves.toBe('high');
  });

  it('fails closed when the concrete model does not expose a known preset', async () => {
    setRecentReasoningPreset('model-fast', 'high');
    await expect(resolveReasoningPresetForSessionCreation('fast')).resolves.toBeUndefined();
  });
});
