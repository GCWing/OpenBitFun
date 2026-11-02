import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { modelSelectionImageLimit } from './modelImageBudget';

function model(id: string, max_images_per_request?: number, overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    id, name: id, model_name: id, provider: 'openai', base_url: 'https://example.test',
    enabled: true, category: 'multimodal', capabilities: [], max_images_per_request, ...overrides,
  };
}

describe('image admission across model selection candidates', () => {
  it('uses the narrowest explicit native-image ceiling across automatic fallback routes', () => {
    const primary = model('primary', 5, { channel_routing: { version: 1, fallback_model_ids: ['backup', 'legacy'] } });
    expect(modelSelectionImageLimit([primary, model('backup', 3), model('legacy')], primary)).toBe(3);
  });

  it('keeps a manually fixed channel independent of the other route ceilings', () => {
    const primary = model('primary', 5, { channel_routing: {
      version: 1, fallback_model_ids: ['backup'], manual_channel: 'primary',
    } });
    const models = [primary, model('backup', 3)];
    expect(modelSelectionImageLimit(models, primary)).toBe(5);
    primary.channel_routing!.manual_channel = 'backup';
    expect(modelSelectionImageLimit(models, primary)).toBe(3);
  });

  it('includes all enabled native pool candidates and their automatic fallback routes', () => {
    const routed = model('routed', 5, { channel_routing: { version: 1, fallback_model_ids: ['backup'] } });
    const models = [routed, model('backup', 3), model('legacy'), model('disabled', 1, {
      enabled: false, channel_routing: { version: 1, fallback_model_ids: ['unrelated'] },
    }),
      model('text', 1, { category: 'general_chat', capabilities: ['text_chat'] }), model('unrelated', 1)];
    expect(modelSelectionImageLimit(models, undefined, ['routed', 'legacy', 'disabled', 'text'])).toBe(3);
    expect(modelSelectionImageLimit(models, undefined, ['legacy', 'disabled', 'text'])).toBeUndefined();
  });

  it('preserves legacy selections and does not use another configured model as fallback', () => {
    const primary = model('primary');
    expect(modelSelectionImageLimit([primary, model('unrelated', 1)], primary)).toBeUndefined();
    expect(modelSelectionImageLimit([model('unrelated', 1)])).toBeUndefined();
  });
});
