import type { AuthConfig, ImageDialect, ImageServiceConfig } from '@/infrastructure/config/types';

/**
 * Per-dialect presentation facts.
 *
 * The backend owns the request and response shapes; this table only decides what
 * the settings UI may offer, so an unsupported field is never shown as if it
 * worked.
 */
export interface ImageDialectPreset {
  id: ImageDialect;
  labelKey: string;
  descriptionKey: string;
  /** Endpoint path appended to the service root. */
  endpointPath: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** Common size values in this dialect's own syntax. */
  sizes: string[];
  maxImagesPerRequest: number;
  supports: {
    negativePrompt: boolean;
    quality: boolean;
    background: boolean;
    outputFormat: boolean;
    watermark: boolean;
    promptExtend: boolean;
    seed: boolean;
  };
}

export const IMAGE_DIALECT_PRESETS: readonly ImageDialectPreset[] = [
  {
    id: 'openai_images',
    labelKey: 'dialect.openaiImages.name',
    descriptionKey: 'dialect.openaiImages.description',
    endpointPath: '/images/generations',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-image-1',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    maxImagesPerRequest: 10,
    supports: {
      negativePrompt: false,
      quality: true,
      background: true,
      outputFormat: false,
      watermark: false,
      promptExtend: false,
      seed: false,
    },
  },
  {
    id: 'dashscope_native',
    labelKey: 'dialect.dashscopeNative.name',
    descriptionKey: 'dialect.dashscopeNative.description',
    endpointPath: '/services/aigc/multimodal-generation/generation',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    defaultModel: 'qwen-image-plus',
    sizes: ['1024*1024', '1664*928', '928*1664', '2048*2048'],
    maxImagesPerRequest: 6,
    supports: {
      negativePrompt: true,
      quality: false,
      background: false,
      outputFormat: false,
      watermark: true,
      promptExtend: true,
      seed: true,
    },
  },
  {
    id: 'chatgpt_codex',
    labelKey: 'dialect.chatgptCodex.name',
    descriptionKey: 'dialect.chatgptCodex.description',
    endpointPath: '/responses',
    // The login supplies this address; the value here only seeds a new draft.
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    // Empty means "discover from the account catalog when sending".
    defaultModel: '',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    maxImagesPerRequest: 1,
    supports: {
      negativePrompt: false,
      quality: true,
      background: true,
      outputFormat: false,
      watermark: false,
      promptExtend: false,
      seed: false,
    },
  },
];

export function findImageDialectPreset(dialect: ImageDialect): ImageDialectPreset {
  return IMAGE_DIALECT_PRESETS.find(preset => preset.id === dialect) ?? IMAGE_DIALECT_PRESETS[0];
}

/** Keep credential reuse and explicit authentication selection on the same route. */
export function withImageServiceAuth(service: ImageServiceConfig, auth: AuthConfig): ImageServiceConfig {
  if (auth.type === 'subscription_pool') return { ...service, auth };
  const dialect = auth.type === 'subscription' && auth.provider === 'codex'
    ? 'chatgpt_codex'
    : service.dialect === 'chatgpt_codex' ? 'openai_images' : service.dialect;
  if (dialect === service.dialect) return { ...service, auth };
  const preset = findImageDialectPreset(dialect);
  return {
    ...service,
    auth,
    dialect,
    base_url: preset.defaultBaseUrl,
    request_url: undefined,
    model_name: preset.defaultModel,
    params: { ...service.params, size: undefined, n: 1 },
  };
}

/** Endpoint the request will actually be sent to. */
export function resolveImageEndpoint(
  baseUrl: string,
  requestUrl: string | undefined,
  dialect: ImageDialect,
): string {
  const override = requestUrl?.trim();
  if (override) return override;

  const root = baseUrl.trim().replace(/\/+$/, '');
  if (!root) return '';
  const path = findImageDialectPreset(dialect).endpointPath;
  return root.endsWith(path) ? root : `${root}${path}`;
}
