import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '../types';
import { configsNeedingAutoTest } from './modelConnectionTestPlan';

function model(id: string, overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    id,
    name: 'Provider',
    provider: 'openai',
    api_key: 'secret',
    base_url: 'https://example.com/v1',
    request_url: 'https://example.com/v1/chat/completions',
    model_name: id,
    context_window: 128000,
    enabled: true,
    category: 'general_chat',
    capabilities: ['text_chat', 'function_calling'],
    auth: { type: 'api_key' },
    ...overrides,
  };
}

describe('configsNeedingAutoTest', () => {
  it('tests only newly added models when a provider model list changes', () => {
    const previous = [model('alpha'), model('beta')];
    const added = model('gamma');

    expect(configsNeedingAutoTest(previous, [...previous, added], true)).toEqual([added]);
  });

  it('uses one representative when shared provider connection settings change', () => {
    const previous = [model('alpha'), model('beta'), model('gamma')];
    const next = previous.map(config => ({ ...config, api_key: 'rotated-secret' }));

    expect(configsNeedingAutoTest(previous, next, true).map(config => config.id)).toEqual(['alpha']);
  });

  it('uses a newly added model as the representative for a simultaneous provider edit', () => {
    const previous = [model('alpha'), model('beta')];
    const next = [
      ...previous.map(config => ({ ...config, base_url: 'https://new.example.com/v1' })),
      model('gamma', { base_url: 'https://new.example.com/v1' }),
    ];

    expect(configsNeedingAutoTest(previous, next, true).map(config => config.id)).toEqual(['gamma']);
  });

  it('does not probe changes that only affect local model metadata', () => {
    const previous = [model('alpha')];
    const next = [{
      ...previous[0],
      context_window: 200000,
      max_tokens: 32000,
      metadata: { user_tags: ['planning', 'execution'] },
      reasoning: {
        catalog: { source: 'auto' as const },
        presets: [],
      },
    }];

    expect(configsNeedingAutoTest(previous, next, true)).toEqual([]);
    expect(configsNeedingAutoTest(previous, next, false)).toEqual([]);
  });

  it('retests a model when its image probe requirement changes', () => {
    const previous = [model('alpha')];
    const next = [model('alpha', {
      category: 'multimodal',
      capabilities: ['text_chat', 'image_understanding'],
    })];

    expect(configsNeedingAutoTest(previous, next, true)).toEqual(next);
  });

  it('automatically probes only one model for a newly created provider', () => {
    const next = [model('alpha'), model('beta')];

    expect(configsNeedingAutoTest([], next, false)).toEqual([next[0]]);
  });
});
