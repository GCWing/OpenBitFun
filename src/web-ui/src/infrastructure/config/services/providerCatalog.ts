import { BUILTIN_PROVIDER_TEMPLATES } from './builtinProviderCatalog';

export interface ProviderUrlCatalogItem {
  id: string;
  baseUrl: string;
  baseUrlOptions?: string[];
}

export const PROVIDER_URL_CATALOG: ProviderUrlCatalogItem[] = Object.values(
  BUILTIN_PROVIDER_TEMPLATES,
).map(template => ({
  id: template.id,
  baseUrl: template.baseUrl,
  baseUrlOptions: template.baseUrlOptions?.map(option => option.url),
}));

export function normalizeProviderBaseUrl(url: string): string {
  let normalized = url.trim().replace(/#$/, '').replace(/\/+$/, '');

  normalized = normalized
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/v1\/messages$/i, '');

  const geminiModelEndpointMatch = normalized.match(/^(.*)\/models\/[^/?#:]+(?::[^/?#]+)?(?:\?.*)?$/i);
  if (geminiModelEndpointMatch?.[1]) {
    normalized = geminiModelEndpointMatch[1].replace(/\/+$/, '');
  }

  normalized = normalized.replace(/\/v1beta$/i, '');

  return normalized;
}

interface NormalizedCatalogEntry {
  item: ProviderUrlCatalogItem;
  normalizedUrl: string;
}

const normalizedCatalogCache = new WeakMap<ProviderUrlCatalogItem[], NormalizedCatalogEntry[]>();

function getNormalizedCatalogEntries(
  catalog: ProviderUrlCatalogItem[],
): NormalizedCatalogEntry[] {
  const cached = normalizedCatalogCache.get(catalog);
  if (cached) return cached;

  const entries: NormalizedCatalogEntry[] = [];
  for (const item of catalog) {
    entries.push({ item, normalizedUrl: normalizeProviderBaseUrl(item.baseUrl) });
    const options = item.baseUrlOptions;
    if (options) {
      for (const option of options) {
        entries.push({ item, normalizedUrl: normalizeProviderBaseUrl(option) });
      }
    }
  }
  // Longest-first so the first match is the most specific candidate.
  entries.sort((a, b) => b.normalizedUrl.length - a.normalizedUrl.length);

  normalizedCatalogCache.set(catalog, entries);
  return entries;
}

export function matchProviderCatalogItemByBaseUrl(
  baseUrl?: string,
  catalog: ProviderUrlCatalogItem[] = PROVIDER_URL_CATALOG
): ProviderUrlCatalogItem | undefined {
  const configBaseUrl = baseUrl?.trim();
  if (!configBaseUrl) return undefined;

  const normalizedConfigBaseUrl = normalizeProviderBaseUrl(configBaseUrl);
  const entries = getNormalizedCatalogEntries(catalog);

  for (const entry of entries) {
    const candidateUrl = entry.normalizedUrl;
    if (
      normalizedConfigBaseUrl === candidateUrl ||
      normalizedConfigBaseUrl.startsWith(`${candidateUrl}/`) ||
      candidateUrl.startsWith(`${normalizedConfigBaseUrl}/`)
    ) {
      return entry.item;
    }
  }

  return undefined;
}

const providerSegmentCache = new Map<string, string | undefined>();
const PROVIDER_SEGMENT_CACHE_LIMIT = 256;

export function extractProviderSegmentFromBaseUrl(baseUrl?: string): string | undefined {
  const rawBaseUrl = baseUrl?.trim();
  if (!rawBaseUrl) return undefined;

  if (providerSegmentCache.has(rawBaseUrl)) {
    return providerSegmentCache.get(rawBaseUrl);
  }

  let segment: string | undefined;
  try {
    const hostname = new URL(rawBaseUrl).hostname.toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length >= 2) {
      segment = parts[parts.length - 2];
    } else {
      segment = parts[0];
    }
  } catch {
    segment = undefined;
  }

  if (providerSegmentCache.size >= PROVIDER_SEGMENT_CACHE_LIMIT) {
    providerSegmentCache.clear();
  }
  providerSegmentCache.set(rawBaseUrl, segment);

  return segment;
}
