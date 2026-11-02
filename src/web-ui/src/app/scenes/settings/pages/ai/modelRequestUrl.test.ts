import { describe, expect, it } from 'vitest';

import { BUILTIN_PROVIDER_TEMPLATES } from '@/infrastructure/config/services/builtinProviderCatalog';

import {
  endpointPresetsForFormat,
  findSelectedEndpointPreset,
  remapBaseUrlForFormat,
  resolveRequestUrl,
} from './modelRequestUrl';

const openai = BUILTIN_PROVIDER_TEMPLATES.openai;
const zhipu = BUILTIN_PROVIDER_TEMPLATES.zhipu;
const qwen = BUILTIN_PROVIDER_TEMPLATES.qwen;
const siliconflow = BUILTIN_PROVIDER_TEMPLATES.siliconflow;

describe('model endpoint presets', () => {
  it('lists only presets that serve the selected request format', () => {
    expect(endpointPresetsForFormat(openai.baseUrlOptions, 'responses').map(option => option.url))
      .toEqual(['https://api.openai.com/v1/responses']);
    expect(endpointPresetsForFormat(openai.baseUrlOptions, 'openai').map(option => option.url))
      .toEqual(['https://api.openai.com/v1']);
    expect(endpointPresetsForFormat(undefined, 'openai')).toEqual([]);
  });

  it('selects a preset by its effective request URL, not by base URL text alone', () => {
    // The OpenAI chat preset URL with the Responses format still targets the Responses preset.
    expect(findSelectedEndpointPreset(openai.baseUrlOptions, 'https://api.openai.com/v1/', 'responses')?.url)
      .toBe('https://api.openai.com/v1/responses');
    expect(findSelectedEndpointPreset(openai.baseUrlOptions, 'https://api.openai.com/v1', 'openai')?.url)
      .toBe('https://api.openai.com/v1');
    expect(findSelectedEndpointPreset(openai.baseUrlOptions, 'https://proxy.example.com/v1', 'openai'))
      .toBeUndefined();
    expect(findSelectedEndpointPreset(openai.baseUrlOptions, 'https://api.openai.com/v1#', 'openai'))
      .toBeUndefined();
  });

  it('moves a preset base URL to the same-host preset of the new format', () => {
    const chatBase = remapBaseUrlForFormat(
      openai.baseUrlOptions, openai.baseUrl, 'responses', 'openai', openai.baseUrl,
    );
    expect(chatBase).toBe('https://api.openai.com/v1');
    expect(resolveRequestUrl(chatBase, 'openai')).toBe('https://api.openai.com/v1/chat/completions');
    expect(remapBaseUrlForFormat(openai.baseUrlOptions, chatBase, 'openai', 'responses', openai.baseUrl))
      .toBe('https://api.openai.com/v1/responses');

    expect(remapBaseUrlForFormat(
      zhipu.baseUrlOptions, 'https://api.z.ai/api/paas/v4', 'openai', 'anthropic', zhipu.baseUrl,
    )).toBe('https://api.z.ai/api/anthropic');
    expect(remapBaseUrlForFormat(
      zhipu.baseUrlOptions, 'https://open.bigmodel.cn/api/anthropic', 'anthropic', 'openai', zhipu.baseUrl,
    )).toBe(zhipu.baseUrl);
    expect(remapBaseUrlForFormat(
      qwen.baseUrlOptions, 'https://coding.dashscope.aliyuncs.com/v1', 'openai', 'anthropic', qwen.baseUrl,
    )).toBe('https://coding.dashscope.aliyuncs.com/apps/anthropic');
  });

  it('keeps custom URLs and never jumps to another host, plan, or region', () => {
    expect(remapBaseUrlForFormat(
      openai.baseUrlOptions, 'https://proxy.example.com/v1', 'openai', 'responses', openai.baseUrl,
    )).toBe('https://proxy.example.com/v1');
    expect(remapBaseUrlForFormat(
      openai.baseUrlOptions, 'https://api.openai.com/v1#', 'openai', 'responses', openai.baseUrl,
    )).toBe('https://api.openai.com/v1#');
    expect(remapBaseUrlForFormat(
      siliconflow.baseUrlOptions, 'https://api.siliconflow.com/v1', 'openai', 'anthropic', siliconflow.baseUrl,
    )).toBe('https://api.siliconflow.com/v1');
    expect(remapBaseUrlForFormat(
      qwen.baseUrlOptions, qwen.baseUrl, 'openai', 'anthropic', qwen.baseUrl,
    )).toBe(qwen.baseUrl);
    expect(remapBaseUrlForFormat(
      openai.baseUrlOptions, openai.baseUrl, 'responses', 'gemini', openai.baseUrl,
    )).toBe(openai.baseUrl);
  });
});
