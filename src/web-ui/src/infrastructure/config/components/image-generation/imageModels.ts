import type { AIModelConfig, ImageServiceConfig, MediaConfig } from '../../types';
import { stableJson } from '../modelConnectionTestPlan';
import { resolveImageEndpoint, withImageServiceAuth } from './imageDialects';

/** Compare request behavior, not the generated record id or display name. */
export function sameImageService(left: ImageServiceConfig, right: ImageServiceConfig): boolean {
  const comparable = (value: ImageServiceConfig) => {
    const service = withImageServiceAuth(value, value.auth ?? { type: 'api_key' });
    const params = Object.fromEntries(Object.entries(service.params ?? {}).filter(([, entry]) => entry !== undefined && entry !== ''));
    return {
      dialect: service.dialect,
      endpoint: resolveImageEndpoint(service.base_url, service.request_url, service.dialect).replace(/\/+$/, ''),
      model: service.model_name.trim(),
      auth: service.auth,
      apiKey: service.auth?.type === 'api_key' ? service.api_key.trim() : '',
      headers: service.custom_headers ?? {},
      headersMode: service.custom_headers_mode ?? 'merge',
      skipSslVerify: service.skip_ssl_verify ?? false,
      params: { ...params, n: params.n ?? 1 },
    };
  };
  // Credentials are compared in memory only; never use this value as a DOM id or log it.
  return stableJson(comparable(left)) === stableJson(comparable(right));
}

export function duplicateImageService(services: readonly ImageServiceConfig[], draft: ImageServiceConfig): ImageServiceConfig | undefined {
  const original = services.find(service => service.id === draft.id);
  // Existing duplicate records remain editable; only adding or changing identity can introduce a duplicate.
  if (original && sameImageService(original, draft)) return undefined;
  return services.find(service => service.id !== draft.id && sameImageService(service, draft));
}

export class DuplicateImageServiceError extends Error {
  constructor() { super('An identical image service is already configured'); }
}

export function normalizeMedia(value: MediaConfig | null | undefined): MediaConfig {
  return { ...value, image_services: value?.image_services ?? [] };
}

export function effectiveImageServiceId(media: MediaConfig): string {
  const enabled = media.image_services.filter(service => service.enabled);
  if (enabled.some(service => service.id === media.default_image_service)) return media.default_image_service!;
  return enabled[0]?.id ?? '';
}

export function withDefaultImageService(media: MediaConfig): MediaConfig {
  const id = effectiveImageServiceId(media);
  return id && id !== media.default_image_service ? { ...media, default_image_service: id } : media;
}

export function imageModelLabel(service: ImageServiceConfig): string {
  if (service.name && service.model_name && service.name !== service.model_name) return `${service.name} · ${service.model_name}`;
  return service.name || service.model_name || 'ChatGPT';
}

/** A configured Codex model drives the subscription image tool directly. */
export function configuredSubscriptionImageModels(models: readonly AIModelConfig[]): AIModelConfig[] {
  return models.filter(model => model.enabled && model.id && model.auth?.type === 'subscription' && model.auth.provider === 'codex');
}

export function imageServiceFromSubscriptionModel(model: AIModelConfig): ImageServiceConfig {
  if (model.auth?.type !== 'subscription' || model.auth.provider !== 'codex') {
    throw new Error('This configured model does not support subscription image generation');
  }
  return {
    id: `configured-image:${model.id}`, name: model.name || model.model_name,
    dialect: 'chatgpt_codex', base_url: 'https://chatgpt.com/backend-api/codex',
    model_name: model.model_name, api_key: '', auth: { ...model.auth }, enabled: true,
    params: { n: 1 }, skip_ssl_verify: model.skip_ssl_verify,
  };
}

export function matchesImageModel(service: ImageServiceConfig, query: string, capability: string, provider: string): boolean {
  if (capability && capability !== 'image_generation') return false;
  if (provider && provider !== `image:${service.dialect}`) return false;
  const search = query.trim().toLowerCase();
  return !search || [service.name, service.model_name, service.dialect].join(' ').toLowerCase().includes(search);
}
