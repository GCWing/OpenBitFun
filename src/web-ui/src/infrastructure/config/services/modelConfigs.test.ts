import { beforeEach, describe, expect, it, vi } from 'vitest';

const configManagerMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock('./ConfigManager', () => ({
  configManager: configManagerMock,
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

describe('modelConfigs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not read ai.models when imported for display helpers', async () => {
    await import('./modelConfigs');
    await Promise.resolve();

    expect(configManagerMock.getConfig).not.toHaveBeenCalled();
  });

  it('preserves custom provider names even when the base URL matches a known provider', async () => {
    const { getProviderDisplayName } = await import('./modelConfigs');

    expect(getProviderDisplayName({
      name: 'My Zhipu Proxy',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model_name: 'glm-5',
    })).toBe('My Zhipu Proxy');
  });

  it('keeps legacy URL inference when a provider name is missing', async () => {
    const { getProviderDisplayName } = await import('./modelConfigs');

    expect(getProviderDisplayName({
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model_name: 'glm-5',
    })).toBe('settings/models:providers.zhipu.name');
  });

  it('recognizes the full TokenDance chat completions URL', async () => {
    const { getProviderDisplayName } = await import('./modelConfigs');

    expect(getProviderDisplayName({
      base_url: 'https://tokendance.space/gateway/v1/chat/completions',
      model_name: 'glm-5.2',
    })).toBe('settings/models:providers.tokendance.name');
  });

  it('allocates readable model config IDs with collision and selector handling', async () => {
    const { allocateModelConfigId } = await import('./modelConfigs');

    expect(allocateModelConfigId('gpt-5-mini', [])).toBe('gpt-5-mini');
    expect(allocateModelConfigId('gpt-5-mini', ['gpt-5-mini'])).toBe('gpt-5-mini-2');
    expect(allocateModelConfigId('gpt-5-mini', ['gpt-5-mini', 'gpt-5-mini-2'])).toBe('gpt-5-mini-3');
    expect(allocateModelConfigId('primary', [])).toBe('primary-2');
    expect(allocateModelConfigId('AUTO', [])).toBe('AUTO-2');
  });

  it('counts nested references to every model in a provider deletion', async () => {
    const { countModelConfigReferences } = await import('./modelConfigs');
    const modelIds = new Set(['model-a', 'model-b']);

    expect(countModelConfigReferences({
      primary: 'model-a',
      fast: 'model-c',
      agents: [{ model: 'model-b' }, { model: 'model-a-suffix' }],
    }, modelIds)).toBe(2);
  });

  it('removes only models from the selected provider instance', async () => {
    const { removeProviderModelConfigs } = await import('./modelConfigs');
    const configs = [
      { id: 'model-a', metadata: { provider_instance_id: 'provider-1' } },
      { id: 'model-b', metadata: { provider_instance_id: 'provider-1' } },
      { id: 'model-c', metadata: { provider_instance_id: 'provider-2' } },
    ];

    expect(removeProviderModelConfigs(configs, 'provider-1')).toEqual({
      remaining: [configs[2]],
      removed: [configs[0], configs[1]],
    });
  });

  it('loads ai.models only when the model manager is actually used', async () => {
    configManagerMock.getConfig.mockResolvedValueOnce([
      {
        id: 'model-1',
        name: 'Provider',
        base_url: 'https://example.test',
        api_key: '',
        model_name: 'model',
        provider: 'openai',
      },
    ]);
    const { modelConfigManager } = await import('./modelConfigs');
    const listener = vi.fn();

    modelConfigManager.addListener(listener);
    await Promise.resolve();
    await Promise.resolve();

    expect(configManagerMock.getConfig).toHaveBeenCalledTimes(1);
    expect(configManagerMock.getConfig).toHaveBeenCalledWith('ai.models');
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'model-1',
        modelName: 'model',
      }),
    ]);
  });

  it('preserves multimodal model metadata when loading and saving ai.models', async () => {
    configManagerMock.getConfig.mockResolvedValueOnce([
      {
        id: 'kimi-1',
        name: 'Moonshot',
        base_url: 'https://api.moonshot.cn/v1',
        api_key: '',
        model_name: 'kimi-k2.7',
        provider: 'openai',
        category: 'multimodal',
        capabilities: ['text_chat', 'image_understanding', 'function_calling'],
        max_images_per_request: 3,
      },
    ]);

    const { modelConfigManager } = await import('./modelConfigs');
    const listener = vi.fn();

    modelConfigManager.addListener(listener);
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'kimi-1',
        category: 'multimodal',
        capabilities: expect.arrayContaining(['image_understanding']),
        maxImagesPerRequest: 3,
      }),
    ]);

    modelConfigManager.updateConfig('kimi-1', {
      category: 'multimodal',
      capabilities: ['text_chat', 'image_understanding', 'function_calling'],
    });

    await Promise.resolve();

    expect(configManagerMock.setConfig).toHaveBeenCalledWith(
      'ai.models',
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kimi-1',
          category: 'multimodal',
          capabilities: expect.arrayContaining(['image_understanding']),
          max_images_per_request: 3,
        }),
      ])
    );
  });
});
