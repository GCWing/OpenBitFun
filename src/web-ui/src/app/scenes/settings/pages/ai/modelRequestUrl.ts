import { supportsResponsesReasoning } from '@/infrastructure/config/utils/reasoning';
import type { ProviderBaseUrlOption } from '@/shared/types';

export function isResponsesProvider(provider?: string): boolean {
  return supportsResponsesReasoning(provider);
}

/**
 * Compute the stored request URL from a base URL and provider format.
 * For Gemini, stores the bare base without the /v1beta/models/... suffix;
 * the backend dynamically appends /v1beta/models/{model}:streamGenerateContent?alt=sse.
 */
export function resolveRequestUrl(baseUrl: string, provider: string, _modelName = ''): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('#')) {
    return trimmed.slice(0, -1).replace(/\/+$/, '');
  }
  if (provider === 'openai') {
    return trimmed.endsWith('chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  }
  if (isResponsesProvider(provider)) {
    return trimmed.endsWith('responses') ? trimmed : `${trimmed}/responses`;
  }
  if (provider === 'anthropic') {
    if (trimmed.endsWith('/messages')) return trimmed;
    return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
  }
  if (provider === 'gemini') {
    return geminiBaseUrl(trimmed);
  }
  return trimmed;
}

/** Strip /v1beta/models/... or /models/... suffix from a gemini URL to get the bare host+path root. */
export function geminiBaseUrl(url: string): string {
  return url
    .replace(/\/v1beta(?:\/models(?:\/[^/?#]*(?::(?:stream)?[Gg]enerateContent)?(?:\?[^]*)?)?)?$/, '')
    .replace(/\/models(?:\/[^/?#]*(?::(?:stream)?[Gg]enerateContent)?(?:\?[^]*)?)?$/, '')
    .replace(/\/+$/, '');
}

/**
 * Build a human-readable preview URL for display in the UI.
 * For Gemini, show the full streaming endpoint with a model placeholder when needed.
 */
export function previewRequestUrl(baseUrl: string, provider: string, modelName?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (provider === 'gemini' && !trimmed.endsWith('#')) {
    const model = modelName?.trim();
    return `${geminiBaseUrl(trimmed)}/v1beta/models/${model ? encodeURIComponent(model) : '{model}'}:streamGenerateContent?alt=sse`;
  }
  return resolveRequestUrl(baseUrl, provider);
}

// The request format select owns the API format; provider endpoint presets only
// pick a host/plan for that format. Two presets that differ only by format would
// otherwise duplicate the format select and can disagree with it.

function sameRequestEndpoint(baseUrl: string, format: string, preset: ProviderBaseUrlOption): boolean {
  return resolveRequestUrl(baseUrl, format).toLowerCase()
    === resolveRequestUrl(preset.url, preset.format).toLowerCase();
}

function urlHost(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

function urlPath(url: string): string {
  try {
    return new URL(url.trim()).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function commonPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

/** Presets that serve the given request format. */
export function endpointPresetsForFormat(
  presets: readonly ProviderBaseUrlOption[] | undefined,
  format: string,
): ProviderBaseUrlOption[] {
  return (presets ?? []).filter(preset => preset.format === format);
}

/** The preset that resolves to the same request URL as the current base URL and format. */
export function findSelectedEndpointPreset(
  presets: readonly ProviderBaseUrlOption[] | undefined,
  baseUrl: string,
  format: string,
): ProviderBaseUrlOption | undefined {
  if (!baseUrl.trim() || baseUrl.trim().endsWith('#')) return undefined;
  return endpointPresetsForFormat(presets, format)
    .find(preset => sameRequestEndpoint(baseUrl, format, preset));
}

/**
 * Pick the base URL to use after the request format changes. Only a base URL that
 * still equals a provider preset is moved, and only to a preset of the new format on
 * the same host, so a custom URL or a different plan/region is never replaced.
 */
export function remapBaseUrlForFormat(
  presets: readonly ProviderBaseUrlOption[] | undefined,
  baseUrl: string,
  fromFormat: string,
  toFormat: string,
  defaultBaseUrl?: string,
): string {
  if (!presets?.length || fromFormat === toFormat || !baseUrl.trim() || baseUrl.trim().endsWith('#')) {
    return baseUrl;
  }
  const current = presets.find(preset => sameRequestEndpoint(baseUrl, fromFormat, preset));
  if (!current) return baseUrl;
  if (current.format === toFormat) return current.url;

  const host = urlHost(current.url);
  const candidates = endpointPresetsForFormat(presets, toFormat)
    .filter(preset => host !== null && urlHost(preset.url) === host);
  if (candidates.length === 0) return baseUrl;

  const preferred = candidates.find(preset => preset.url === defaultBaseUrl);
  if (preferred) return preferred.url;
  const currentPath = urlPath(current.url);
  return candidates.reduce((best, preset) => (
    commonPrefixLength(urlPath(preset.url), currentPath) > commonPrefixLength(urlPath(best.url), currentPath)
      ? preset
      : best
  )).url;
}
