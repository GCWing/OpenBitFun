import en from '@/locales/en-US/scenes/capabilities.json';
import cn from '@/locales/zh-CN/scenes/capabilities.json';
import tw from '@/locales/zh-TW/scenes/capabilities.json';
import { describe, expect, it } from 'vitest';
import { INTERACTIVE_CAPABILITY_CATALOG } from '../interactiveCapabilityCatalog';
import type { GlobalSearchRequest } from '../types';
import { interactiveCapabilitySearchProvider } from './interactiveCapabilitySearchProvider';

const resources = { 'en-US': en, 'zh-CN': cn, 'zh-TW': tw };
function translate(locale: keyof typeof resources, key: string): string {
  const value = key.split('.').reduce<unknown>((current, segment) =>
    current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined, resources[locale]);
  expect(typeof value, `${locale}:${key}`).toBe('string');
  return String(value);
}
function request(query: string, locale: keyof typeof resources = 'en-US'): GlobalSearchRequest {
  return {
    rawQuery: query,
    query,
    scope: 'all',
    workspaces: [],
    currentWorkspace: null,
    limitPerGroup: 20,
    tCommon: (key) => key,
    tCapabilities: key => translate(locale, key),
    tSettings: (key) => key,
  };
}

describe('interactiveCapabilitySearchProvider', () => {
  it.each(['en-US', 'zh-CN', 'zh-TW'] as const)('uses %s display labels for both English and Chinese queries', async locale => {
    const labels: string[] = [];
    for (const query of ['terminal', '终端']) {
      const result = await interactiveCapabilitySearchProvider.search(request(query, locale), new AbortController().signal);
      const terminal = result.items.find(item => item.target.kind === 'capability' && item.target.capabilityId === 'feature.terminal')!;
      labels.push(terminal.title);
      expect(terminal.context).not.toContain('feature.');
      expect(terminal.badge).toBe(translate(locale, 'search.kinds.feature'));
    }
    expect(labels[0]).toBe(labels[1]);
    expect(labels[0]).toBe(translate(locale, 'search.capabilities.feature.terminal.title'));
  });

  it('provides translated labels for every catalog target and subview', () => {
    for (const locale of Object.keys(resources) as Array<keyof typeof resources>) {
      for (const capability of INTERACTIVE_CAPABILITY_CATALOG.capabilities) {
        translate(locale, `search.capabilities.${capability.id}.title`);
        translate(locale, `search.capabilities.${capability.id}.summary`);
        translate(locale, `search.categories.${capability.categoryId}`);
        for (const item of capability.items) translate(locale, `search.capabilities.${capability.id}.items.${item.id}`);
      }
    }
  });

  it.each(['en-US', 'zh-CN', 'zh-TW'] as const)('discovers image generation with a localized %s label', async locale => {
    const result = await interactiveCapabilitySearchProvider.search(
      request('generate_image', locale),
      new AbortController().signal,
    );
    const imageGeneration = result.items.find(item => item.target.kind === 'capability'
      && item.target.capabilityId === 'feature.ai-assistant');
    expect(imageGeneration?.target).toMatchObject({ kind: 'capability', itemId: 'image-generation' });
    expect(imageGeneration?.subtitle).toBe(translate(locale, 'search.capabilities.feature.ai-assistant.items.image-generation'));
  });

  it('restores accelerated search in the settings catalog', () => {
    const capability = INTERACTIVE_CAPABILITY_CATALOG.capabilities.find(
      ({ id }) => id === 'setting.workspace.session',
    );
    expect(capability?.options.some(({ id }) => id === 'workspace-search')).toBe(true);
    expect(capability?.items.some(({ id }) => id === 'accelerated-search')).toBe(true);
  });
  it('hides Flashgrep search entries for remote workspaces', async () => {
    const query = request('Flashgrep');
    query.currentWorkspace = { workspaceKind: 'remote' } as typeof query.currentWorkspace;
    const result = await interactiveCapabilitySearchProvider.search(query, new AbortController().signal);
    expect(result.items).toEqual([]);
  });
  it('uses the curated feature-and-settings contract', () => {
    expect(INTERACTIVE_CAPABILITY_CATALOG.capabilities).toHaveLength(
      INTERACTIVE_CAPABILITY_CATALOG.counts.userFacing,
    );
    expect(new Set(INTERACTIVE_CAPABILITY_CATALOG.capabilities.map(({ id }) => id)).size)
      .toBe(INTERACTIVE_CAPABILITY_CATALOG.capabilities.length);
    expect(INTERACTIVE_CAPABILITY_CATALOG.capabilities.every(({ kind }) =>
      kind === 'feature' || kind === 'setting')).toBe(true);
  });

  it('finds a capability by its English terms', async () => {
    const result = await interactiveCapabilitySearchProvider.search(
      request('terminal'),
      new AbortController().signal,
    );
    expect(result.items.some((item) => item.target.kind === 'capability'
      && item.target.capabilityId === 'feature.terminal')).toBe(true);
  });

  it('finds the same catalog by Chinese terms', async () => {
    const result = await interactiveCapabilitySearchProvider.search(
      request('终端'),
      new AbortController().signal,
    );
    expect(result.items.some((item) => item.target.kind === 'capability'
      && item.target.capabilityId === 'feature.terminal')).toBe(true);
  });

  it('returns settings from the same semantic provider in the settings group', async () => {
    const result = await interactiveCapabilitySearchProvider.search(
      request('MCP server'),
      new AbortController().signal,
    );
    const mcp = result.items.find((item) => item.target.kind === 'capability'
      && item.target.capabilityId === 'setting.tools.mcp');
    expect(mcp?.providerId).toBe('interactive-capabilities');
    expect(mcp?.group).toBe('settings');
  });

  it('discovers the dedicated terminal settings page', async () => {
    const result = await interactiveCapabilitySearchProvider.search(
      request('default shell settings'),
      new AbortController().signal,
    );
    expect(result.items.some((item) => item.target.kind === 'capability'
      && item.target.capabilityId === 'setting.application.terminal')).toBe(true);
  });

  it.each([
    ['快捷键', 'setting.application.shortcuts', 'shortcut-browser'],
    ['editor font', 'setting.application.development', 'editor-appearance'],
    ['Hooks 设置', 'setting.tools.automation', 'hooks-enabled'],
  ])('routes %s to the matching settings subview', async (query, capabilityId, itemId) => {
    const result = await interactiveCapabilitySearchProvider.search(
      request(query),
      new AbortController().signal,
    );
    const match = result.items.find((item) => item.target.kind === 'capability'
      && item.target.capabilityId === capabilityId);
    expect(match?.target).toEqual({ kind: 'capability', capabilityId, itemId });
  });

  it('finds the browser element picker from Chinese and English sub-capability text', async () => {
    for (const query of ['元素选择器', 'element picker']) {
      const result = await interactiveCapabilitySearchProvider.search(
        request(query),
        new AbortController().signal,
      );
      const browser = result.items.find((item) => item.target.kind === 'capability'
        && item.target.capabilityId === 'feature.browser');
      expect(browser).toBeDefined();
      expect(browser?.subtitle.toLowerCase()).toContain(
        'element picker',
      );
      expect(browser?.context).toBe('Projects & development');
    }
  });

  it('keeps personal assistants separate from subagent management', async () => {
    for (const query of ['育苗场', 'persona documents']) {
      const result = await interactiveCapabilitySearchProvider.search(
        request(query),
        new AbortController().signal,
      );
      const assistant = result.items.find((item) => item.target.kind === 'capability'
        && item.target.capabilityId === 'feature.personal-assistants');
      expect(assistant).toBeDefined();
      expect(assistant?.target.kind === 'capability' && assistant.target.capabilityId)
        .not.toBe('feature.agents');
    }
  });

  it('satisfies the shared cross-surface search acceptance corpus', async () => {
    for (const acceptance of INTERACTIVE_CAPABILITY_CATALOG.searchAcceptance) {
      const result = await interactiveCapabilitySearchProvider.search(
        request(acceptance.query),
        new AbortController().signal,
      );
      // Git remains in the host discovery contract, but no longer has a Web UI panel entry.
      if (acceptance.expectedFirstCapabilityId === 'feature.git') {
        expect(result.items.some(item => item.target.kind === 'capability'
          && item.target.capabilityId === 'feature.git')).toBe(false);
        continue;
      }
      const ranked = [...result.items].sort((left, right) => right.score - left.score);
      expect(
        ranked[0]?.target.kind === 'capability' ? ranked[0].target.capabilityId : undefined,
        acceptance.id,
      ).toBe(acceptance.expectedFirstCapabilityId);
      const capabilityIds = new Set(result.items.flatMap((item) =>
        item.target.kind === 'capability' ? [item.target.capabilityId] : []));
      for (const capabilityId of acceptance.expectedCapabilityIds) {
        expect(capabilityIds.has(capabilityId), `${acceptance.id} missed ${capabilityId}`).toBe(true);
      }
      if (acceptance.expectedItem) {
        const match = result.items.find((item) => item.target.kind === 'capability'
          && item.target.capabilityId === acceptance.expectedItem?.capabilityId);
        expect(match?.target, `${acceptance.id} item route`).toEqual({
          kind: 'capability',
          capabilityId: acceptance.expectedItem.capabilityId,
          itemId: acceptance.expectedItem.itemId,
        });
      }
    }
  });
});
