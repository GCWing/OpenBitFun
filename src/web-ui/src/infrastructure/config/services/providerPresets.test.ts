import { describe, expect, it, vi } from 'vitest';

import enUS from '@/locales/en-US/settings/models.json';
import zhCN from '@/locales/zh-CN/settings/models.json';
import zhTW from '@/locales/zh-TW/settings/models.json';

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

const LOCALES = { 'en-US': enUS, 'zh-CN': zhCN, 'zh-TW': zhTW } as Record<
  string,
  { providers: Record<string, { urlOptions?: Record<string, string> }> }
>;

async function loadPresets() {
  const [{ PROVIDER_TEMPLATES }, { PROVIDER_URL_CATALOG }, { resolveProviderTemplates }] = await Promise.all([
    import('./modelConfigs'),
    import('./providerCatalog'),
    import('./builtinProviderCatalog'),
  ]);
  return { PROVIDER_TEMPLATES, PROVIDER_URL_CATALOG, resolveProviderTemplates };
}

/**
 * Provider product facts come from the shared overlay. These checks keep the Web
 * projection, URL matcher and locale labels aligned with that single source.
 */
describe('provider presets', () => {
  it('offers every preset URL through the provider URL catalog', async () => {
    const { PROVIDER_TEMPLATES, PROVIDER_URL_CATALOG } = await loadPresets();

    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      const catalogItem = PROVIDER_URL_CATALOG.find(item => item.id === template.id);
      expect(catalogItem, `provider ${template.id} is missing from PROVIDER_URL_CATALOG`).toBeDefined();

      const catalogUrls = new Set([catalogItem!.baseUrl, ...(catalogItem!.baseUrlOptions ?? [])]);
      const presetUrls = new Set([
        template.baseUrl,
        ...(template.baseUrlOptions ?? []).map(option => option.url),
      ]);

      expect([...presetUrls].filter(url => !catalogUrls.has(url))).toEqual([]);
      expect([...catalogUrls].filter(url => !presetUrls.has(url))).toEqual([]);
    }
  });

  it('resolves every base URL option note in all locales, with distinct labels per request format', async () => {
    const { PROVIDER_TEMPLATES } = await loadPresets();

    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      const options = template.baseUrlOptions ?? [];
      if (options.length === 0) continue;

      const notes = options.map(option => option.note);
      expect(new Set(notes).size, `${template.id} reuses a note key`).toBe(notes.length);

      for (const [tag, bundle] of Object.entries(LOCALES)) {
        const urlOptions = bundle.providers[template.id]?.urlOptions ?? {};
        const labels = notes.map(note => urlOptions[note]);

        expect(
          labels.filter(label => !label),
          `${tag} is missing providers.${template.id}.urlOptions entries`,
        ).toEqual([]);
        // The endpoint picker lists one request format at a time, so labels name the
        // region or plan and must differ only among endpoints of the same format.
        for (const format of new Set(options.map(option => option.format))) {
          const formatLabels = options
            .filter(option => option.format === format)
            .map(option => urlOptions[option.note]);
          expect(
            new Set(formatLabels).size,
            `${tag} renders duplicate ${format} labels for ${template.id}`,
          ).toBe(formatLabels.length);
        }
        expect(Object.keys(urlOptions).filter(key => !notes.includes(key))).toEqual([]);
      }
    }
  });

  it('declares a home market for every preset provider', async () => {
    const { PROVIDER_TEMPLATES } = await loadPresets();

    // The preset picker ranks by region, so an overlay entry without one would
    // silently land in the region-neutral group that sorts above everything else.
    const regionless = Object.values(PROVIDER_TEMPLATES)
      .filter(template => template.region !== 'cn' && template.region !== 'global')
      .map(template => template.id);
    expect(regionless, 'only explicitly neutral providers may omit a home market').toEqual(['openbitfun', 'opencode-go']);
    for (const id of regionless) expect(PROVIDER_TEMPLATES[id].region).toBe('any');
  });

  it('shapes base URLs so the adapter appends the right suffix', async () => {
    const { PROVIDER_TEMPLATES } = await loadPresets();

    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      const entries = [
        { url: template.baseUrl, format: template.format },
        ...(template.baseUrlOptions ?? []),
      ];

      for (const { url, format } of entries) {
        if (format === 'anthropic') {
          // The Anthropic adapter appends /v1/messages itself.
          expect(url.endsWith('/v1'), `${template.id}: ${url} would request /v1/v1/messages`).toBe(false);
        }
        if (format === 'openai') {
          expect(url.endsWith('/messages'), `${template.id}: ${url} is not an OpenAI path`).toBe(false);
        }
      }
    }
  });

  it('never maps one URL to two providers', async () => {
    const { PROVIDER_TEMPLATES } = await loadPresets();
    const owner = new Map<string, string>();

    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      const urls = [template.baseUrl, ...(template.baseUrlOptions ?? []).map(option => option.url)];
      for (const url of urls) {
        const previous = owner.get(url);
        expect(previous ?? template.id, `${url} is claimed by ${previous} and ${template.id}`).toBe(template.id);
        owner.set(url, template.id);
      }
    }
  });

  it('merges backend catalog models without allowing it to replace product endpoints', async () => {
    const { PROVIDER_TEMPLATES, resolveProviderTemplates } = await loadPresets();
    const fallback = PROVIDER_TEMPLATES.qwen;
    const resolved = resolveProviderTemplates({
      revision: 'test',
      source: 'mixed',
      providers: [{
        id: 'qwen',
        display_order: 20,
        name: 'External display name',
        description: 'Catalog description',
        requires_api_key: true,
        endpoints: [{
          id: 'default',
          base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          api_format: 'openai',
          label: 'default',
          is_default: true,
          trusted_for_auto_detection: true,
        }],
        models: [{
          id: 'qwen-new',
          recommended: false,
          source: 'models_dev',
          capabilities: {
            chat: true,
            tool_call: true,
            reasoning: true,
            attachment: false,
            structured_output: false,
          },
        }],
      }],
    });

    expect(resolved.qwen.models).toEqual(['qwen-new']);
    expect(resolved.qwen.baseUrl).toBe(fallback.baseUrl);
    expect(resolved.qwen.format).toBe(fallback.format);

    const rejected = resolveProviderTemplates({
      revision: 'test',
      source: 'mixed',
      providers: [{
        id: 'qwen',
        display_order: 20,
        name: 'Qwen',
        description: 'Qwen',
        requires_api_key: true,
        endpoints: [{
          id: 'default',
          base_url: 'https://gateway.example.com/v1',
          api_format: 'openai',
          label: 'default',
          is_default: true,
          trusted_for_auto_detection: false,
        }],
        models: [],
      }],
    });
    expect(rejected.qwen.baseUrl).toBe(fallback.baseUrl);
    expect(rejected.qwen.format).toBe(fallback.format);
  });
});
